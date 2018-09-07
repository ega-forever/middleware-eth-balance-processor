/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Egor Zuev <zyev.egor@gmail.com>
 */

const models = require('../../models'),
  _ = require('lodash'),
  contract = require('truffle-contract'),
  erc20token = require('../../contracts/TokenContract.json'),
  erc20contract = contract(erc20token),
  Promise = require('bluebird'),
  crypto = require('crypto'),
  memwatch = require('memwatch-next'),
  getUpdatedBalance = require('../../utils/balance/getUpdatedBalance'),
  transferEventToQueryConverter = require('../../utils/converters/transferEventToQueryConverter'),
  expect = require('chai').expect;

module.exports = (ctx) => {

  before(async () => {
    await models.txModel.remove({});
    await models.txLogModel.remove({});
    await models.accountModel.remove({});


    await models.accountModel.create({
      address: ctx.accounts[0],
      balance: 0,
      erc20token: {},
      isActive: true
    });

  });

  it('generate erc20 transfers', async () => {
    const balance = await Promise.promisify(ctx.web3.eth.getBalance)(ctx.accounts[0]);
    expect(parseInt(balance.toString())).to.be.gt(0);

    erc20contract.setProvider(ctx.web3.currentProvider);

    for (let s = 0; s < 10; s++) {
      const erc20TokenInstance = await erc20contract.new({from: ctx.accounts[1], gas: 1000000});
      await Promise.delay(1000);
      console.log(`generated token: `, erc20TokenInstance.address);

      for (let i = 0; i < 10; i++) {

        console.log('submitting new tx');
        const tx = await erc20TokenInstance.transfer(ctx.accounts[0], 1000, {from: ctx.accounts[1]});

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
      }
    }

    const start = Date.now();
    let hd = new memwatch.HeapDiff();
    const balances = await getUpdatedBalance(ctx.accounts[0]);

    let diff = hd.end();
    let leakObjects = _.filter(diff.change.details, detail => detail.size_bytes / 1024 / 1024 > 3);

    expect(leakObjects.length).to.be.eq(0);
    expect(Date.now() - start).to.be.below(10000);
    expect(Object.keys(balances.tokens).length).to.eq(10);
  });

  it('validate transferEventToQueryConverter function', async () => {
    const query = transferEventToQueryConverter({from: ctx.accounts[1]});
    const logCount = await models.txLogModel.count(query);
    expect(logCount).to.eq(100);
  });

};
