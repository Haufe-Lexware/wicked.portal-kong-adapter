'use strict';
/*jshint loopfunc: true */

var async = require('async');
var debug = require('debug')('kong-adapter:sync');
var kong = require('./kong');
var portal = require('./portal');
var utils = require('./utils');

var sync = function () { };

// ========= INTERFACE FUNCTIONS ========

sync.syncApis = function (app, done) {
    debug('syncApis()');
    async.parallel({
        portalApis: function (callback) { portal.getPortalApis(app, callback); },
        kongApis: function (callback) { kong.getKongApis(app, callback); }
    }, function (err, results) {
        if (err)
            return done(err);
        var portalApis = results.portalApis;
        var kongApis = results.kongApis;

        var todoLists = assembleApiTodoLists(portalApis, kongApis);
        debug(utils.getText(todoLists));

        async.series({
            addApis: function (callback) {
                kong.addKongApis(app, todoLists.addList, callback);
            },
            updateApis: function (callback) {
                // Will call syncPlugins
                kong.updateKongApis(app, sync, todoLists.updateList, callback);
            },
            deleteApis: function (callback) {
                kong.deleteKongApis(app, todoLists.deleteList, callback);
            }
        }, function (err) {
            if (err)
                return done(err);
            debug("syncApis() finished.");
            return done(null);
        });
    });
};

sync.syncPlugins = function (app, portalApi, kongApi, done) {
    debug('syncPlugins()');
    var todoLists = assemblePluginTodoLists(portalApi, kongApi);
    debug(utils.getText(todoLists));

    debug('portalApi');
    debug(portalApi);
    debug('kongApi');
    debug(kongApi);

    async.series({
        addPlugins: function (callback) {
            kong.addKongPlugins(app, todoLists.addList, callback);
        },
        updatePlugins: function (callback) {
            kong.updateKongPlugins(app, todoLists.updateList, callback);
        },
        deletePlugins: function (callback) {
            kong.deleteKongPlugins(app, todoLists.deleteList, callback);
        }
    }, function (err) {
        if (err)
            return done(err);
        debug("sync.syncPlugins() done.");
        return done(null);
    });
};

sync.syncConsumers = function (app, done) {
    debug('syncConsumers()');
    async.parallel({
        portalConsumers: function (callback) {
            portal.getPortalConsumers(app, callback);
        },
        kongConsumers: function (callback) {
            kong.getKongConsumers(app, callback);
        }
    }, function (err, results) {
        if (err)
            return done(err);

        var portalConsumers = results.portalConsumers;
        var kongConsumers = results.kongConsumers;

        var todoLists = assembleConsumerTodoLists(portalConsumers, kongConsumers);
        debug(utils.getText(todoLists));

        async.series({
            addConsumers: function (callback) {
                kong.addKongConsumers(app, todoLists.addList, callback);
            },
            updateConsumers: function (callback) {
                // Will call syncConsumerApiPlugins
                kong.updateKongConsumers(app, sync, todoLists.updateList, callback);
            },
            deleteConsumers: function (callback) {
                kong.deleteKongConsumers(app, todoLists.deleteList, callback);
            }
        }, function (err, results) {
            if (err)
                return done(err);
            debug('sync.syncConsumers() done.');
            return done(null);
        });
    });
};

sync.syncConsumerApiPlugins = function (app, portalConsumer, kongConsumer, done) {
    debug('syncConsumerApiPlugins()');
    var todoLists = assembleConsumerApiPluginsTodoLists(portalConsumer, kongConsumer);

    async.series([
        function (callback) {
            kong.addKongConsumerApiPlugins(app, todoLists.addList, kongConsumer.consumer.id, callback);
        },
        function (callback) {
            kong.patchKongConsumerApiPlugins(app, todoLists.patchList, callback);
        },
        function (callback) {
            kong.deleteKongConsumerApiPlugins(app, todoLists.deleteList, callback);
        }
    ], function (err) {
        if (err)
            return done(err);
        debug('syncConsumerApiPlugins() finished.');
        return done(null);
    });
};

// ========= INTERNALS ===========

function assembleApiTodoLists(portalApis, kongApis) {
    debug('assembleApiTodoLists()');
    const updateList = [];
    const addList = [];
    const deleteList = [];

    const handledKongApis = {};

    for (let i = 0; i < portalApis.apis.length; ++i) {
        let portalApi = portalApis.apis[i];

        let kongApi = kongApis.apis.find(function (thisApi) { return thisApi.api.name == portalApi.id; });
        if (kongApi) {
            // Found in both Portal and Kong, check for updates
            updateList.push({
                portalApi: portalApi,
                kongApi: kongApi
            });
            handledKongApis[kongApi.api.name] = true;
        }
        else {
            // Api not known in Kong, we need to add this
            addList.push({
                portalApi: portalApi
            });
        }
    }

    // Now do the mop up, clean up APIs in Kong but not in the Portal;
    // these we want to delete.
    for (var i = 0; i < kongApis.apis.length; ++i) {
        let kongApi = kongApis.apis[i];
        if (!handledKongApis[kongApi.api.name]) {
            deleteList.push({
                kongApi: kongApi
            });
        }
    }

    return {
        addList: addList,
        updateList: updateList,
        deleteList: deleteList
    };
}

function assemblePluginTodoLists(portalApi, kongApi) {
    debug('assemblePluginTodoLists()');
    const addList = [];
    const updateList = [];
    const deleteList = [];

    var handledKongPlugins = {};
    for (let i = 0; i < portalApi.config.plugins.length; ++i) {
        let portalPlugin = portalApi.config.plugins[i];
        let kongPluginIndex = utils.getIndexBy(kongApi.plugins, function (plugin) { return plugin.name == portalPlugin.name; });
        if (kongPluginIndex < 0) {
            addList.push({
                portalApi: portalApi,
                portalPlugin: portalPlugin,
                kongApi: kongApi
            });
        } else {
            let kongPlugin = kongApi.plugins[kongPluginIndex];
            if (!utils.matchObjects(portalPlugin, kongPlugin)) {
                updateList.push(
                    {
                        portalApi: portalApi,
                        portalPlugin: portalPlugin,
                        kongApi: kongApi,
                        kongPlugin: kongPlugin
                    });
            } // Else: Matches, all is good
            handledKongPlugins[kongPlugin.name] = true;
        }
    }

    // Mop up needed?
    for (let i = 0; i < kongApi.plugins.length; ++i) {
        let kongPlugin = kongApi.plugins[i];
        if (!handledKongPlugins[kongPlugin.name]) {
            deleteList.push({
                kongApi: kongApi,
                kongPlugin: kongPlugin
            });
        }
    }

    return {
        addList: addList,
        updateList: updateList,
        deleteList: deleteList
    };
}

function assembleConsumerTodoLists(portalConsumers, kongConsumers) {
    debug('assembleConsumerTodoLists()');
    const addList = [];
    const updateList = [];
    const deleteList = [];

    var handledKongConsumers = {};
    for (var i = 0; i < portalConsumers.length; ++i) {
        let portalConsumer = portalConsumers[i];
        let kongConsumer = kongConsumers.find(function (kongConsumer) { return portalConsumer.consumer.username == kongConsumer.consumer.username; });
        if (!kongConsumer) {
            debug('Username "' + portalConsumer.consumer.username + '" in portal, but not in Kong, add needed.');
            // Not found
            addList.push({
                portalConsumer: portalConsumer
            });
            continue;
        }

        // We have the consumer in both the Portal and Kong
        debug('Found username "' + kongConsumer.consumer.username + '" in portal and Kong, check for update.');
        updateList.push({
            portalConsumer: portalConsumer,
            kongConsumer: kongConsumer
        });

        handledKongConsumers[kongConsumer.consumer.username] = true;
    }

    // Mop up?
    for (let i = 0; i < kongConsumers.length; ++i) {
        let kongConsumer = kongConsumers[i];
        if (!handledKongConsumers[kongConsumer.consumer.username]) {
            debug('Username "' + kongConsumer.consumer.username + "' found in Kong, but not in portal, delete needed.");
            // Superfluous consumer; we control them
            deleteList.push({
                kongConsumer: kongConsumer
            });
        }
    }

    return {
        addList: addList,
        updateList: updateList,
        deleteList: deleteList
    };
}

function assembleConsumerApiPluginsTodoLists(portalConsumer, kongConsumer) {
    debug('assembleConsumerApiPluginsTodoLists()');
    const addList = [];
    const patchList = [];
    const deleteList = [];
    const handledPlugins = {};
    for (let i = 0; i < portalConsumer.apiPlugins.length; ++i) {
        let portalApiPlugin = portalConsumer.apiPlugins[i];
        let kongApiPlugin = kongConsumer.apiPlugins.find(function (p) { return p.name == portalApiPlugin.name; });
        if (!kongApiPlugin) { // not found, add it
            addList.push({
                portalConsumer: portalConsumer,
                portalApiPlugin: portalApiPlugin
            });
            continue;
        }

        if (kongApiPlugin && 
            !utils.matchObjects(portalApiPlugin, kongApiPlugin)) {
            patchList.push({
                portalConsumer: portalConsumer,
                portalApiPlugin: portalApiPlugin,
                kongConsumer: kongConsumer,
                kongApiPlugin: kongApiPlugin
            });
        }

        handledPlugins[portalApiPlugin.name] = true;
    }

    // Mop up
    for (let i = 0; i < kongConsumer.apiPlugins.length; ++i) {
        let kongApiPlugin = kongConsumer.apiPlugins[i];
        if (!handledPlugins[kongApiPlugin.name]) {
            deleteList.push({
                kongConsumer: kongConsumer,
                kongApiPlugin: kongApiPlugin
            });
        }
    }

    return {
        addList: addList,
        patchList: patchList,
        deleteList: deleteList
    };
}

module.exports = sync;