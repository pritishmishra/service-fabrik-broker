'use strict';
const _ = require('lodash');
const Promise = require('bluebird');
const azureStorage = require('azure-storage');
const logger = require('../../common/logger');
const errors = require('../../common/errors');
const utils = require('../../common/utils');
const uuid = require('uuid');
const ComputeClient = require('./ComputeClient');
const BaseCloudClient = require('./BaseCloudClient');
const NotFound = errors.NotFound;
const Unauthorized = errors.Unauthorized;
const Forbidden = errors.Forbidden;

class AzureClient extends BaseCloudClient {
  constructor(settings) {
    super(settings);
    this.constructor.validateParams(_.chain(this.settings).value());
    this.storage = this.constructor.createStorageClient(_
      .chain(this.settings)
      .omit('name')
      .set('provider', this.provider)
      .value()
    );
    this.computeClient = this.constructor.createComputeClient(_
      .chain(this.settings)
      .set('provider', this.provider)
      .value()
    );
    Promise.promisifyAll(this.computeClient.snapshots);
    Promise.promisifyAll(this.computeClient.disks);
  }

  getSnapshot(snapshotId) {
    return this.computeClient.snapshots.getAsync(this.settings.resource_group, snapshotId)
      .then(snapshotResponse => _.pick(snapshotResponse, ['location', 'creationData', 'id']));
  }

  convertToBoshDiskFormat(diskName) {
    const boshDiskSegments = ['caching:None', `disk_name:${diskName}`, `resource_group_name:${this.settings.resource_group}`];
    const boshDiskName = _.join(boshDiskSegments, encodeURIComponent(';'));
    return boshDiskName;
  }

  createDiskFromSnapshot(snapshotId, zones, opts = {}) {
    const diskName = `bosh-disk-data-${uuid.v4()}`;
    const boshDiskName = this.convertToBoshDiskFormat(diskName);
    return Promise.try(() => this.getSnapshot(snapshotId))
      .then(snapshotData => {
        const options = {
          zones: _.isArray(zones) ? zones : [zones],
          location: snapshotData.location,
          tags: _.assign({}, opts.tags || {}, {
            createdBy: 'service-fabrik',
            caching: 'None',
            resource_group_name: this.settings.resource_group
          }),
          sku: _.assign({}, {
            name: opts.type || 'Premium_LRS'
          }),
          creationData: {
            createOption: 'Copy',
            sourceUri: snapshotData.id
          }
        };
        return this.computeClient.disks.createOrUpdateAsync(this.settings.resource_group, diskName, options);
      })
      .then(diskResponse => ({
        volumeId: boshDiskName,
        size: diskResponse.diskSizeGB,
        zone: diskResponse.zones[0],
        type: diskResponse.sku ? diskResponse.sku.name : '',
        extra: {
          type: diskResponse.sku,
          sku: diskResponse.sku,
          tags: diskResponse.tags
        }
      }));
  }

  getDiskMetadata(diskId) {
    const decodedDiskId = decodeURIComponent(diskId);
    const boshDiskSegments = _.split(decodedDiskId, ';');
    let diskName;
    if (boshDiskSegments.length > 1) {
      diskName = _.chain(boshDiskSegments)
        .filter(seg => _.startsWith(seg, 'disk_name:'))
        .head()
        .split(':')
        .last()
        .value();
    } else {
      diskName = decodedDiskId;
    }
    return this.computeClient.disks
      .getAsync(this.settings.resource_group, diskName)
      .then(diskResponse => ({
        volumeId: this.convertToBoshDiskFormat(diskResponse.name),
        size: diskResponse.diskSizeGB,
        zone: diskResponse.zones[0],
        type: diskResponse.sku ? diskResponse.sku.name : '',
        extra: {
          sku: diskResponse.sku,
          type: diskResponse.sku,
          tags: diskResponse.tags
        }
      }));
  }

  getContainer(container) {
    if (arguments.length < 1) {
      container = this.containerName;
    }
    return this.storage
      .getContainerPropertiesAsync(container)
      .then(result => result);
  }

  list(container, options) {
    if (arguments.length < 2) {
      options = container;
      container = this.containerName;
    }
    const prefix = options ? options.prefix : null;
    // TODO Need to update following line with value from 'options' e.g. options.marker
    let continuationToken = null;
    // TODO : maxResult is 5000 
    // https://azure.github.io/azure-storage-node/BlobService.html#listBlobsSegmentedWithPrefix__anchor
    // If want to fetch more use 'continuationToken' returned in result
    return this.storage
      .listBlobsSegmentedWithPrefixAsync(container, prefix, continuationToken)
      .then(result => {
        const listOfFiles = result.entries;
        continuationToken = result.continuationToken;
        let isTruncated = continuationToken ? true : false;
        const files = [];
        _.each(listOfFiles, file => files.push(_
          .chain(file)
          .pick('name', 'lastModified')
          .set('isTruncated', isTruncated)
          .value()
        ));
        return files;
      });
  }

  remove(container, file) {
    if (arguments.length < 2) {
      file = container;
      container = this.containerName;
    }
    logger.debug(`Deleting file ${file} in container ${container} `);
    return this.storage
      .deleteBlobAsync(container, file)
      .then(response => logger.info(`Response of blob deletion from cloud storage for ${file} in container ${container}:`, response))
      .catch(BaseCloudClient.providerErrorTypes.Unauthorized, err => {
        logger.error(err.message);
        throw new Unauthorized(`Authorization at cloud storage provider failed while deleting blob ${file} in container ${container}`);
      })
      .catch(BaseCloudClient.providerErrorTypes.Forbidden, err => {
        logger.error(err.message);
        throw new Forbidden(`Authentication at cloud storage provider failed while deleting blob ${file} in container ${container}`);
      })
      .catchThrow(BaseCloudClient.providerErrorTypes.NotFound,
        new NotFound(`Object '${file}' not found while deleting in container ${container}`));
  }

  download(options) {
    return utils.streamToPromise(this.storage.createReadStream(
      options.container, options.remote))
      .catchThrow(BaseCloudClient.providerErrorTypes.NotFound, new NotFound(`Object '${options.remote}' not found`));
  }

  upload(options, buffer) {
    return new Promise((resolve, reject) => {
      function cleanup() {
        uploadedStream.removeListener('finish', onfinish);
        uploadedStream.removeListener('error', onerror);
      }

      function onerror(err) {
        cleanup();
        reject(err);
      }

      function onfinish() {
        cleanup();
        resolve(JSON.parse(buffer));
      }

      let uploadedStream = this.storage
        .createWriteStreamToBlockBlob(
          options.container, options.remote);

      uploadedStream.on('error', onerror);
      uploadedStream.on('finish', onfinish);
      uploadedStream.end(buffer);
    });
  }

  uploadJson(container, file, data) {
    if (arguments.length < 3) {
      data = file;
      file = container;
      container = this.containerName;
    }
    return this
      .upload({
        container: container,
        remote: file
      }, new Buffer(JSON.stringify(data, null, 2), 'utf8'));
  }

  downloadJson(container, file) {
    if (arguments.length < 2) {
      file = container;
      container = this.containerName;
    }
    return this
      .download({
        container: container,
        remote: file
      })
      .then(data => JSON.parse(data))
      .catchThrow(SyntaxError, new NotFound(`Object '${file}' not found`));
  }

  deleteSnapshot(snapshotName) {
    return Promise
      .try(() => {
        return this.computeClient
          .snapshots
          .deleteMethodAsync(this.settings.resource_group, snapshotName)
          .then(retval => logger.info(`Deleted snapshot ${snapshotName}`, retval))
          .catch(err => {
            logger.error(`Error occured while deleting snapshot ${snapshotName}`, err);
            throw err;
          });
      });
  }

  static validateParams(options) {
    /* Param validation is done only for resource_group as at the time storage and compute client
      creattion others params are validated by default */
    if (!options) {
      throw new Error('AzureClient can not be instantiated as backup provider config not found');
    } else {
      if (!options.resource_group) {
        throw new Error('AzureClient can not be instantiated as resource_group not found in backup provider config');
      }
    }
    return true;
  }
  static createStorageClient(options) {
    return Promise.promisifyAll(
      azureStorage.createBlobService(options.storageAccount, options.storageAccessKey));
  }

  static createComputeClient(settings) {
    return ComputeClient.createComputeClient(settings).value();
  }
}

module.exports = AzureClient;
