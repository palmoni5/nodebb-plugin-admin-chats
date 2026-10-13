'use strict';

const hooks = require('./lib/hooks');
const { registerRoutes, renderAdminChatsPage } = require('./lib/routes');
const { overrideMessagingFunctions, overrideChatsApi, overrideCoreChatRedirect, overrideCoreChatsPage } = require('./lib/overrides');
const { overrideForActivityTracking, backfillActivitySet } = require('./lib/activity');

const plugin = Object.assign({}, hooks);

plugin.init = async function (params) {
    registerRoutes(params.app, params.router, params.middleware);
    overrideMessagingFunctions();
    overrideChatsApi();
    overrideCoreChatRedirect(params.controllers, renderAdminChatsPage);
    overrideCoreChatsPage(params.controllers);
    overrideForActivityTracking();
    await backfillActivitySet();
};

module.exports = plugin;
