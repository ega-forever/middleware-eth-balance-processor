/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Egor Zuev <zyev.egor@gmail.com>
 */

const providerService = require('../../services/providerService'),
  models = require('../../models'),
  transferEventToQueryConverter = require('../converters/transferEventToQueryConverter'),
  _ = require('lodash'),
  Promise = require('bluebird'),
  erc20tokenDefinition = require('../../contracts/TokenContract.json');

/**
 * @function
 * @description calculate the balance of the user (general balance + erc20)
 * @param address - user's address
 * @param tx - the transaction, emitted by the user (optional)
 * @return {Promise<void>}
 */
module.exports = async (address, tx) => {

  const web3 = await providerService.get();

  const Erc20Contract = web3.eth.contract(erc20tokenDefinition.abi);
  const balances = {};

  const query = transferEventToQueryConverter(tx ? {} : {
    $or: [{to: address}, {from: address}]
  });

  let tokens = tx ? _.chain(tx)
      .get('logs', [])
      .filter({signature: query.signature})
      .map(log => log.address)
      .uniq()
      .value() :
    await models.txLogModel.distinct('address', query);

  balances.tokens = await Promise.mapSeries(tokens, async token => {
    const contractInstance = Erc20Contract.at(token);
    let balance = await Promise.promisify(contractInstance.balanceOf.call)(address);
    let symbol = await Promise.promisify(contractInstance.symbol.call)();
    let decimals = await Promise.promisify(contractInstance.decimals.call)().catch(() => '18');

    return {
      symbol: symbol,
      decimals: decimals.toString(),
      address: token,
      balance: balance.toString()
    };
  });

  balances.balance = (await Promise.promisify(web3.eth.getBalance)(address)).toString();
  return balances;
};
