/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Egor Zuev <zyev.egor@gmail.com>
 */

const config = require('../config'),
  Web3 = require('web3'),
  net = require('net'),
  _ = require('lodash'),
  providerServiceInterface = require('middleware-common-components/interfaces/blockProcessor/providerServiceInterface'),
  AbstractProvider = require('middleware-common-components/abstract/universal/AbstractProvider');

/**
 * @service
 * @description the service for handling connection to node
 * @returns Object<ProviderService>
 */

class ProviderService extends AbstractProvider {

  constructor () {
    super();
  }


  makeWeb3FromProviderURI (providerURI) {

    const provider = /^http/.test(providerURI) ?
      new Web3.providers.HttpProvider(providerURI) :
      new Web3.providers.IpcProvider(`${/^win/.test(process.platform) ? '\\\\.\\pipe\\' : ''}${providerURI}`, net);

    const web3 = new Web3();
    web3.setProvider(provider);
    return web3;
  }

  /** @function
   * @description reset the current connection
   */
  async resetConnector () {
    await this.connector.reset();
    this.switchConnector();
    this.events.emit('disconnected');
  }


  /**
   * @function
   * @description start listen for provider updates from block processor
   * @private
   */
  _startListenProviderUpdates () {

    this.rabbitmqChannel.consume(`${config.rabbit.serviceName}_provider.${this.id}`, async (message) => {
      message = JSON.parse(message.content.toString());
      const providerURI = config.web3.providers[message.index];


      const fullProviderURI = !/^http/.test(providerURI) ? `${/^win/.test(process.platform) ? '\\\\.\\pipe\\' : ''}${providerURI}` : providerURI;
      const currentProviderURI = this.connector ? this.connector.currentProvider.path || this.connector.currentProvider.host : '';

      if (currentProviderURI === fullProviderURI)
        return;


      this.connector = this.makeWeb3FromProviderURI(providerURI);

      if (_.get(this.connector.currentProvider, 'connection')) {
        this.connector.currentProvider.connection.on('end', () => this.resetConnector());
        this.connector.currentProvider.connection.on('error', () => this.resetConnector());
      } else
        this.pingIntervalId = setInterval(async () => {

          const isConnected = await new Promise((res, rej) => {
            this.connector.currentProvider.sendAsync({
              id: 9999999999,
              jsonrpc: '2.0',
              method: 'net_listening',
              params: []
            }, (err, result) => err ? rej(err) : res(result.result));
          });

          if (!isConnected) {
            clearInterval(this.pingIntervalId);
            this.resetConnector();
          }
        }, 5000);

      this.events.emit('provider_set');
    }, {noAck: true});

  }

}

module.exports = providerServiceInterface(new ProviderService());
