/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Kirill Sergeev <cloudkserg11@gmail.com>
 */
const accountModel = require('../models/accountModel');

module.exports = async (web3, address) => {
  let balance = await Promise.promisify(web3.eth.getBalance)(address);
  return await accountModel.findOneAndUpdate(
    {address}, 
    {$set: {balance}}, 
    {new: true}
  );
};
