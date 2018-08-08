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
  contract = require('truffle-contract'),
  erc20token = require('../../contracts/TokenContract.json'),
  erc20contract = contract(erc20token),
  spawn = require('child_process').spawn,
  expect = require('chai').expect,
  Promise = require('bluebird');

module.exports = (ctx) => {

  before(async () => {
    await models.txModel.remove({});
    await models.txLogModel.remove({});
    await models.accountModel.remove({});
    await ctx.amqp.channel.deleteQueue(`${config.rabbit.serviceName}.balance_processor`);

    ctx.balanceProcessorPid = spawn('node', ['index.js'], {env: process.env, stdio: 'ignore'});
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
        let txHash = await Promise.promisify(ctx.web3.eth.sendTransaction)({
          from: ctx.accounts[0],
          to: ctx.accounts[1],
          value: 1000
        });
        tx = await Promise.promisify(ctx.web3.eth.getTransaction)(txHash);

        await new Promise(res => {
          let intervalPid = setInterval(async () => {
            tx = await Promise.promisify(ctx.web3.eth.getTransaction)(txHash);
            if (tx.blockNumber) {
              clearInterval(intervalPid);
              res();
            }
          }, 1000)
        });

        balance0 = await Promise.promisify(ctx.web3.eth.getBalance)(ctx.accounts[0]);
        balance1 = await Promise.promisify(ctx.web3.eth.getBalance)(ctx.accounts[1]);
        await ctx.amqp.channel.publish('events', `${config.rabbit.serviceName}_transaction.${ctx.accounts[0]}`, new Buffer(JSON.stringify(tx)));
        await ctx.amqp.channel.publish('events', `${config.rabbit.serviceName}_transaction.${ctx.accounts[1]}`, new Buffer(JSON.stringify(tx)));
      })(),
      (async () => {
        await ctx.amqp.channel.assertQueue(`app_${config.rabbit.serviceName}_test_features.balance`);
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
        await ctx.amqp.channel.assertQueue(`app_${config.rabbit.serviceName}_test_features2.balance`);
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

    let balance = await Promise.promisify(ctx.web3.eth.getBalance)(ctx.accounts[0]);

    await Promise.all([
      (async () => {
        await Promise.delay(3000);
        await ctx.amqp.channel.publish('internal', `${config.rabbit.serviceName}_user.created`, new Buffer(JSON.stringify({address: ctx.accounts[0]})));
      })(),
      (async () => {
        await ctx.amqp.channel.assertQueue(`app_${config.rabbit.serviceName}_test_features.balance`);
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

    erc20contract.setProvider(ctx.web3.currentProvider);
    ctx.erc20TokenInstance = await erc20contract.new({from: ctx.accounts[0], gas: 1000000});
    let balance = await ctx.erc20TokenInstance.balanceOf.call(ctx.accounts[0]);
    expect(balance.toNumber()).to.equal(1000000);

    let tx = await ctx.erc20TokenInstance.transfer(ctx.accounts[1], 1000, {from: ctx.accounts[0]});

    let rawTx = await Promise.promisify(ctx.web3.eth.getTransaction)(tx.tx);
    let rawTxReceipt = await Promise.promisify(ctx.web3.eth.getTransactionReceipt)(tx.tx);

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

    rawTxReceipt.logs = rawTxReceipt.logs.map(log => {
      if (log.topics.length)
        log.signature = log.topics[0];
      return log;
    });

    const logsToSave = rawTxReceipt.logs.map(log => {

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
        address: log.address
      });

      txLog._id = crypto.createHash('md5').update(`${rawTx.blockNumber}x${log.transactionIndex}x${log.logIndex}`).digest('hex');
      return txLog;
    });

    for (let log of logsToSave)
      await models.txLogModel.create(log);

    rawTx.logs = rawTxReceipt.logs;

    let balanceAccount1 = await ctx.erc20TokenInstance.balanceOf.call(ctx.accounts[1]);

    await Promise.all([
      (async () => {
        await Promise.delay(3000);
        await ctx.amqp.channel.publish('events', `${config.rabbit.serviceName}_transaction.${ctx.accounts[1]}`, new Buffer(JSON.stringify(rawTx)));
      })(),
      (async () => {
        await ctx.amqp.channel.assertQueue(`app_${config.rabbit.serviceName}_test_features.balance`);
        await ctx.amqp.channel.bindQueue(`app_${config.rabbit.serviceName}_test_features.balance`, 'events', `${config.rabbit.serviceName}_balance.${ctx.accounts[1]}`);
        await new Promise(res =>
          ctx.amqp.channel.consume(`app_${config.rabbit.serviceName}_test_features.balance`, async data => {

            if (!data)
              return;

            const message = JSON.parse(data.content.toString());

            expect(_.isEqual(JSON.parse(JSON.stringify(rawTx)), message.tx)).to.equal(true);
            expect(message.erc20token[ctx.erc20TokenInstance.address]).to.eq(balanceAccount1.toString());
            expect(message.address).to.eq(ctx.accounts[1]);

            await ctx.amqp.channel.deleteQueue(`app_${config.rabbit.serviceName}_test_features.balance`);
            res();
          }, {noAck: true})
        );

      })()
    ]);
  });


  after(() => {
    delete ctx.erc20TokenInstance;
  })

};
