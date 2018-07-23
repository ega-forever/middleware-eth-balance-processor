/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Kirill Sergeev <cloudkserg11@gmail.com>
 */
const providerService = require('../../services/providerService'),
  models = require('../../models'),
  transferEventToQueryConverter = require('../converters/transferEventToQueryConverter'),
  _ = require('lodash'),
  mongoose = require('mongoose'),
  Promise = require('bluebird'),
  erc20tokenDefinition = require('../../contracts/TokenContract.json');

require('mongoose-long')(mongoose);

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


  balances.tokens = await Promise.map(tokens, async token => {
    let balance = await new Promise((res, rej) =>
      Erc20Contract.at(token).balanceOf.call(address, (err, balance) => err ? rej(err) : res(balance))
    );

    return [token, mongoose.Types.Long.fromString(balance.toString())];
  });

  balances.tokens = _.fromPairs(balances.tokens);
  balances.balance = await Promise.promisify(web3.eth.getBalance)(address);

  return balances;
};
