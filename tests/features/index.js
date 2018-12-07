/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Egor Zuev <zyev.egor@gmail.com>
 */

require('dotenv/config');

const models = require('../../models'),
  config = require('../../config'),
  crypto = require('crypto'),
  _ = require('lodash'),
  erc20token = require('../../contracts/TokenContract.json'),
  RMQTxModel = require('middleware-common-components/models/rmq/eth/txModel'),
  spawn = require('child_process').spawn,
  expect = require('chai').expect,
  Promise = require('bluebird');

module.exports = (ctx) => {

  before(async () => {
    await models.txModel.remove({});
    await models.txLogModel.remove({});
    await models.accountModel.remove({});
    await ctx.amqp.channel.deleteQueue(`${config.rabbit.serviceName}.balance_processor`);

    ctx.balanceProcessorPid = spawn('node', ['index.js'], {env: process.env, stdio: 'inherit'});
    await Promise.delay(5000);

    for (let address of _.take(ctx.accounts, 2))
      await models.accountModel.create({
        address: address,
        balance: 0,
        erc20token: {},
        isActive: true
      });

  });


  it('validate balance change on tx arrive', async () => {

    let tx;
    let balance0;
    let balance1;

    await Promise.all([
      (async () => {
        let txReceipt = await ctx.web3.eth.sendTransaction({
          from: ctx.accounts[0],
          to: ctx.accounts[1],
          value: 1000
        });


        tx = await ctx.web3.eth.getTransaction(txReceipt.transactionHash);

        tx = {
          hash: tx.hash,
          blockNumber: tx.blockNumber,
          blockHash: tx.blockHash,
          transactionIndex: tx.transactionIndex,
          from: tx.from ? tx.from.toLowerCase() : null,
          to: tx.to ? tx.to.toLowerCase() : null,
          gas: tx.gas.toString(),
          gasPrice: tx.gasPrice.toString(),
          gasUsed: txReceipt.gasUsed ? txReceipt.gasUsed.toString() : '21000',
          logs: tx.logs,
          nonce: tx.nonce,
          value: tx.value
        };


        new RMQTxModel(tx);

        balance0 = await ctx.web3.eth.getBalance(ctx.accounts[0]);
        balance1 = await ctx.web3.eth.getBalance(ctx.accounts[1]);
        await ctx.amqp.channel.publish('events', `${config.rabbit.serviceName}_transaction.${ctx.accounts[0]}`, Buffer.from(JSON.stringify(tx)));
        await ctx.amqp.channel.publish('events', `${config.rabbit.serviceName}_transaction.${ctx.accounts[1]}`, Buffer.from(JSON.stringify(tx)));
      })(),
      (async () => {
        await ctx.amqp.channel.assertQueue(`app_${config.rabbit.serviceName}_test_features.balance`, {autoDelete: true});
        await ctx.amqp.channel.bindQueue(`app_${config.rabbit.serviceName}_test_features.balance`, 'events', `${config.rabbit.serviceName}_balance.${ctx.accounts[1]}`);
        await new Promise(res =>
          ctx.amqp.channel.consume(`app_${config.rabbit.serviceName}_test_features.balance`, async data => {

            if (!data)
              return;

            const message = JSON.parse(data.content.toString());

            expect(_.isEqual(JSON.parse(JSON.stringify(tx)), message.tx)).to.equal(true);
            expect(message.balance).to.eq(balance1.toString());
            expect(message.address).to.eq(ctx.accounts[1]);

            await ctx.amqp.channel.deleteQueue(`app_${config.rabbit.serviceName}_test_features.balance`);
            res();
          }, {noAck: true})
        );

      })(),
      (async () => {
        await ctx.amqp.channel.assertQueue(`app_${config.rabbit.serviceName}_test_features2.balance`, {autoDelete: true});
        await ctx.amqp.channel.bindQueue(`app_${config.rabbit.serviceName}_test_features2.balance`, 'events', `${config.rabbit.serviceName}_balance.${ctx.accounts[0]}`);
        await new Promise(res =>
          ctx.amqp.channel.consume(`app_${config.rabbit.serviceName}_test_features2.balance`, async data => {

            if (!data)
              return;

            const message = JSON.parse(data.content.toString());

            expect(message.balance).to.eq(balance0.toString());
            expect(message.address).to.eq(ctx.accounts[0]);

            expect(_.isEqual(JSON.parse(JSON.stringify(tx)), message.tx)).to.equal(true);
            await ctx.amqp.channel.deleteQueue(`app_${config.rabbit.serviceName}_test_features2.balance`);
            res();
          }, {noAck: true})
        );

      })()
    ]);
  });

  it('validate balance on user registration', async () => {

    await models.accountModel.update({address: ctx.accounts[0]}, {
      $set: {
        balance: 0
      }
    });

    let balance = await ctx.web3.eth.getBalance(ctx.accounts[0]);

    await Promise.all([
      (async () => {
        await Promise.delay(3000);
        await ctx.amqp.channel.publish('internal', `${config.rabbit.serviceName}_user.created`, Buffer.from(JSON.stringify({address: ctx.accounts[0]})));
      })(),
      (async () => {
        await ctx.amqp.channel.assertQueue(`app_${config.rabbit.serviceName}_test_features.balance`, {autoDelete: true});
        await ctx.amqp.channel.bindQueue(`app_${config.rabbit.serviceName}_test_features.balance`, 'events', `${config.rabbit.serviceName}_balance.${ctx.accounts[0]}`);
        await new Promise(res =>
          ctx.amqp.channel.consume(`app_${config.rabbit.serviceName}_test_features.balance`, async data => {

            if (!data)
              return;

            const message = JSON.parse(data.content.toString());

            expect(message.balance).to.eq(balance.toString());
            expect(message.address).to.eq(ctx.accounts[0]);
            expect(message.tx).to.eq(null);

            await ctx.amqp.channel.deleteQueue(`app_${config.rabbit.serviceName}_test_features.balance`);
            res();
          }, {noAck: true})
        );

      })()
    ]);
  });

  it('add new ERC20 token', async () => {

    const balance = await ctx.web3.eth.getBalance(ctx.accounts[0]);
    expect(parseInt(balance.toString())).to.be.gt(0);

    const erc20contract = new ctx.web3.eth.Contract(erc20token.abi);

    const erc20TokenInstance = await erc20contract.deploy({data: erc20token.bytecode}).send({
      from: ctx.accounts[0],
      gas: 1000000,
      gasPrice: '30000000000000'
    });

    let tokenBalance = await erc20TokenInstance.methods.balanceOf(ctx.accounts[0]).call();
    expect(tokenBalance).to.equal('1000000');

    let tx = await erc20TokenInstance.methods.transfer(ctx.accounts[1], 1000).send({from: ctx.accounts[0]});


    let rawTx = await ctx.web3.eth.getTransaction(tx.transactionHash);
    let rawTxReceipt = await ctx.web3.eth.getTransactionReceipt(tx.transactionHash);

    const toSaveTx = {
      _id: rawTx.hash,
      index: rawTx.transactionIndex,
      blockNumber: rawTx.blockNumber,
      value: rawTx.value,
      to: rawTx.to,
      nonce: rawTx.nonce,
      gasPrice: rawTx.gasPrice,
      gas: rawTx.gas,
      from: rawTx.from
    };

    await models.txModel.create(toSaveTx);

    const logsToSave = _.chain(rawTxReceipt.logs).cloneDeep().map(log => {

      let args = log.topics;
      let nonIndexedLogs = _.chain(log.data.replace('0x', '')).chunk(64).map(chunk => chunk.join('')).value();
      let dataIndexStart;

      if (args.length && nonIndexedLogs.length) {
        dataIndexStart = args.length;
        args.push(...nonIndexedLogs);
      }


      const txLog = new models.txLogModel({
        blockNumber: rawTx.blockNumber,
        txIndex: log.transactionIndex,
        index: log.logIndex,
        removed: log.removed,
        signature: _.get(log, 'topics.0'),
        args: log.topics,
        dataIndexStart: dataIndexStart,
        address: log.address.toLowerCase()
      });

      txLog._id = crypto.createHash('md5').update(`${rawTx.blockNumber}x${log.transactionIndex}x${log.logIndex}`).digest('hex');
      return txLog;
    }).value();

    for (let log of logsToSave)
      await models.txLogModel.create(log);

    let balanceAccount1 = await erc20TokenInstance.methods.balanceOf(ctx.accounts[1]).call();

    const transformedLogs = _.chain(rawTxReceipt.logs).cloneDeep().map(log => {

      let args = log.topics;
      let nonIndexedLogs = _.chain(log.data.replace('0x', '')).chunk(64).map(chunk => chunk.join('')).value();
      let dataIndexStart;

      if (args.length && nonIndexedLogs.length) {
        dataIndexStart = args.length;
        args.push(...nonIndexedLogs);
      }

      return {
        blockNumber: rawTx.blockNumber,
        txIndex: log.transactionIndex,
        index: log.logIndex,
        removed: log.removed || 0,
        signature: _.get(log, 'topics.0'),
        args: log.topics,
        dataIndexStart: dataIndexStart,
        address: log.address.toLowerCase()
      };

    }).value();


    let transformedTransaction = {
      hash: rawTx.hash,
      blockNumber: rawTx.blockNumber,
      blockHash: rawTx.blockHash,
      transactionIndex: rawTx.transactionIndex,
      from: rawTx.from ? rawTx.from.toLowerCase() : null,
      to: rawTx.to ? rawTx.to.toLowerCase() : null,
      gas: rawTx.gas.toString(),
      gasPrice: rawTx.gasPrice.toString(),
      gasUsed: rawTxReceipt.gasUsed ? rawTxReceipt.gasUsed.toString() : '21000',
      logs: transformedLogs,
      nonce: rawTx.nonce,
      value: rawTx.value
    };

    new RMQTxModel(transformedTransaction);

    await Promise.all([
      (async () => {
        await Promise.delay(3000);
        await ctx.amqp.channel.publish('events', `${config.rabbit.serviceName}_transaction.${ctx.accounts[1]}`, Buffer.from(JSON.stringify(transformedTransaction)));
      })(),
      (async () => {
        await ctx.amqp.channel.assertQueue(`app_${config.rabbit.serviceName}_test_features.balance`, {autoDelete: true});
        await ctx.amqp.channel.bindQueue(`app_${config.rabbit.serviceName}_test_features.balance`, 'events', `${config.rabbit.serviceName}_balance.${ctx.accounts[1]}`);
        await new Promise(res =>
          ctx.amqp.channel.consume(`app_${config.rabbit.serviceName}_test_features.balance`, async data => {

            if (!data)
              return;

            const message = JSON.parse(data.content.toString());

            expect(transformedTransaction).to.deep.equal(message.tx);

            //console.log(message);
            //console.log(erc20TokenInstance.options.address.toLowerCase())

            expect(_.find(message.erc20token, {address: erc20TokenInstance.options.address.toLowerCase()}).balance).to.eq(balanceAccount1.toString());
            expect(message.address).to.eq(ctx.accounts[1]);

            await ctx.amqp.channel.deleteQueue(`app_${config.rabbit.serviceName}_test_features.balance`);
            res();
          }, {noAck: true})
        );

      })()
    ]);
  });


  after(() => {
    ctx.balanceProcessorPid.kill();
  });

};
