/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Kirill Sergeev <cloudkserg11@gmail.com>
 */

const updateBalance = require('../utils/updateBalance');

const EXCHANGE_NAME = 'internal';

/**
 * @class UserCreatedService
 *
 * Class, that listen events from rest about user.created
 * and update balance for this user in database
 *
 *
 */
class UserCreatedService {

  /**
   *
   * Constructor, that only create main variables in class
   * not done anything work
   *
   * @param {web3} web3 Object of class services/nisRequestService
   *
   * @memberOf MasterNode
   */
  constructor (web3, channel, rabbitPrefix) {
    this.channel = channel;
    this.web3 = web3;
    this.rabbitPrefix = rabbitPrefix;
  }

  /**
   *
   * Async start function
   * in this function process subscribe on main events in rabbitmq, connected to elections
   * and through MASTER_UPDATE_TIMEOUT run periodic checkMasterProcess
   *
   * @memberOf MasterNode
   */
  async start () {
    await this.channel.assertExchange(EXCHANGE_NAME, 'topic', {durable: false});
    await this.channel.assertQueue(`${this.rabbitPrefix}_balance_user.created`);
    await this.channel.bindQueue(`${this.rabbitPrefix}_balance_user.created`, EXCHANGE_NAME, 
      `${this.rabbitPrefix}_user.created`);

    this.channel.consume(`${this.rabbitPrefix}_balance_user.created`, async (message) => {
      const accData = JSON.parse(message.content);
      if (accData['address']) 
        await updateBalance(
          this.web3,
          accData['address']
        );
      this.channel.ack(message);
    });
  }

}

module.exports = UserCreatedService;
