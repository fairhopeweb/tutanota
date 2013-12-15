"use strict";

goog.provide('tutao.tutanota.ctrl.GroupData');

/**
 * @param {string} name
 *            the name of the group.
 * @param {string} mailAddr
 * @param {Object} userKey
 *            the symmetric user key used for encrypting the symmetric group key for group
 *            memberships.
 * @param {Object} adminGroupKey
 *            the key of the admin group, used to encrypt the symmetric group key for the admin group.
 * @param {Object} listKey
 *            the key of the list, used to encrypt all regular data of the group (e.g. name)
 * @param {function(?tutao.entity.sys.CreateGroupData, ?Object, exception=)} callback Called when finished. Receives the group data object.
 */
tutao.tutanota.ctrl.GroupData.generateGroupKeys = function(name, mailAddr, userKey, adminGroupKey, listKey, callback) {
	var symGroupKey = tutao.locator.aesCrypter.generateRandomKey();
	tutao.locator.rsaCrypter.generateKeyPair(function(keyPair, exception) {
		if (exception) {
			callback(null, null, exception);
			return;
		}
		var sessionKey = tutao.locator.aesCrypter.generateRandomKey();

        var groupData = new tutao.entity.sys.CreateGroupData()
            .setEncryptedName(tutao.locator.aesCrypter.encryptUtf8(sessionKey, name, true))
            .setMailAddress(mailAddr)
            .setPubKey(tutao.locator.rsaCrypter.keyToHex(keyPair.publicKey))
            .setSymEncPrivKey(tutao.locator.aesCrypter.encryptPrivateRsaKey(symGroupKey, tutao.locator.rsaCrypter.keyToHex(keyPair.privateKey)));

		if (userKey != null) {
            groupData.setSymEncGKey(tutao.locator.aesCrypter.encryptKey(userKey, symGroupKey));
		}
		if (adminGroupKey != null) {
			groupData.setAdminEncGKey(tutao.locator.aesCrypter.encryptKey(adminGroupKey, symGroupKey));
		} else {
            // this is the adminGroup
            groupData.setAdminEncGKey(tutao.locator.aesCrypter.encryptKey(symGroupKey, symGroupKey));
        }

        groupData.setListEncSessionKey(tutao.locator.aesCrypter.encryptKey(listKey, sessionKey));

		callback(groupData, symGroupKey);
	});
};