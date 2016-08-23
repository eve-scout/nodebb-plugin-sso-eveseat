(function(module) {

  'use strict';

  var	user = module.parent.require('./user'),
    Groups = module.parent.require('./groups'),
    meta = module.parent.require('./meta'),
    SocketAdmin = module.parent.require('./socket.io/admin').plugins,
    db = module.parent.require('./database'),
    async = require('async'),
    passport = module.parent.require('passport'),
    PassportEveseat = require('passport-eveseat').Strategy,
    nconf = module.parent.require('nconf'),
    winston = module.parent.require('winston'),
    helpers = module.parent.require('./routes/helpers'),
    app;

  var authenticationController = module.parent.require('./controllers/authentication');

  var constants = Object.freeze({
    'name': 'EVE SeAT',
    'admin': {
      'route': '/plugins/sso-eveseat',
      'icon': 'fa-shield'
    }
  });

  var EveSeat = {};

  // Hook: onLoad
  EveSeat.onLoad = function(application, callback) {
    // Load settings onLoad should make them available for all other methods
    if (!EveSeat.settings) {
      return EveSeat.getSettings(function() {
        EveSeat.onLoad(application, callback);
      });
    }

    // Setup routing
    application.router.get('/admin/plugins/sso-eveseat', application.middleware.admin.buildHeader, EveSeat.renderAdmin);
    application.router.get('/api/admin/plugins/sso-eveseat', EveSeat.renderAdmin);
    helpers.setupPageRoute(application.router, '/auth/eveseat/error', application.middleware, [], EveSeat.renderError);

    // Setup sockets for admin panel
    SocketAdmin.EveSeat = {
      createGroupMapping: EveSeat.createGroupMapping,
      deleteGroupMapping: EveSeat.deleteGroupMapping,
      getAllGroupMappings: EveSeat.getAllGroupMappings
    };

    app = application.app;

    // Done
    callback();
  };

  // Hook: Add menu item to Social Authentication admin menu
  EveSeat.addMenuItem = function(nav, callback) {
    nav.authentication.push({
      'route' : constants.admin.route,
      'icon'  : constants.admin.icon,
      'name'  : constants.name
    });

    callback(null, nav);
  };

  // Hook: Render an error page
  EveSeat.renderError = function(req, res, next) {
    var data = {
      title: (EveSeat.settings.frontendName || constants.name) + ' Login Error',
      supportMessage: EveSeat.settings.supportMessage
    };

    res.render('client/sso-eveseat-error', data);
  };

  // Hook: Render admin panel
  EveSeat.renderAdmin = function(req, res, next) {
    async.parallel({
      groupMappings: function(callback) {
        getAllGroupMappings(callback);
      },
      groups: function(callback) {
        Groups.getGroupsFromSet('groups:visible:name', 0, 0, -1, callback);
      }
    }, function(err, result) {
      res.render('admin/plugins/sso-eveseat', result);
    });
  };

  // Load settings
  EveSeat.getSettings = function(callback) {
    if (EveSeat.settings) {
      return callback();
    }

    meta.settings.get('sso-eveseat', function(err, settings) {
      winston.verbose('[plugin-sso-eveseat] Loaded Settings');

      EveSeat.settings = settings;
      callback();
    });
  };

  // Hook: passport strategy
  EveSeat.getStrategy = function(strategies, callback) {

    if (
      EveSeat.settings !== undefined &&
      EveSeat.settings.hasOwnProperty('clientId') && EveSeat.settings.clientId &&
      EveSeat.settings.hasOwnProperty('clientSecret') && EveSeat.settings.clientSecret &&
      EveSeat.settings.hasOwnProperty('baseUri') && EveSeat.settings.baseUri
    ) {
      // Define passport
      passport.use(new PassportEveseat({
        clientID: EveSeat.settings.clientId,
        clientSecret: EveSeat.settings.clientSecret,
        baseURI: EveSeat.settings.baseUri,
        scope: 'character.profile,character.roles,email',
        callbackURL: nconf.get('url') + '/auth/eveseat/callback',
        failureUrl: nconf.get('url') + '/auth/eveseat/error',
        passReqToCallback: true
      }, function(req, accessToken, refreshToken, profile, done) {
        // Make unique id based on account and characterID
        var eveseatid = 'character_' + profile.accountCreateDate + '-' + profile.characterID;

        // If user is already logged in
        if (req.hasOwnProperty('user') && req.user.hasOwnProperty('uid') && req.user.uid > 0) {
          // Save Eve Seat specific information to the user
          user.setUserField(req.user.uid, 'eveseatid', eveseatid);
          db.setObjectField('eveseat:uid', eveseatid, req.user.uid);

          return done(null, req.user);
        }

        // If account is not active
        if (! profile.accountActive) {
          return done(new Error('Sorry, your account is disabled. Contact Support.')); 
        }

        // Login the user
        EveSeat.login(eveseatid, profile, accessToken, refreshToken, function(err, user) {
          if (err) {
            return done(err);
          }

          // Store settings
          EveSeat.storeTokens(user.uid, accessToken, refreshToken);
          EveSeat.updateProfile(user.uid, profile, function(err, result) {

            authenticationController.onSuccessfulLogin(req, user.uid);

            done(null, user);
          });
        });
      }));

      strategies.push({
        name: 'eveseat',
        url: '/auth/eveseat',
        icon: constants.admin.icon,
        scope: 'character.profile,character.roles,email',
        callbackURL: '/auth/eveseat/callback',
        failureUrl: '/auth/eveseat/error'
      });
    }

    callback(null, strategies);
  };

  // Login from strategy
  EveSeat.login = function(eveseatid, profile, accessToken, refreshToken, callback) {
    EveSeat.getUidByEveSeatId(eveseatid, function(err, uid) {
      if(err) {
        return callback(err);
      }

      if (uid !== null) {
        // Existing User
        winston.verbose('[plugin-sso-eveseat] Logging in User via plugin-sso-eveseat ' + uid);

        callback(null, {
          uid: uid
        });
      } else {
        // var handle = profile.characterName.toLowerCase().trim().replace(/\s+/g, '');

        var handle = profile.characterName;

        winston.verbose('[plugin-sso-eveseat] Creating New User via plugin-sso-eveseat ' +  handle);

        // New User
        user.create({username: handle}, function(err, uid) {
          if(err) {
            return callback(err);
          }

          // Save Eve SeAT specific information to the user
          user.setUserField(uid, 'eveseatid', eveseatid);
          db.setObjectField('eveseatid:uid', eveseatid, uid);

          callback(null, {
            uid: uid
          });
        });
      }
    });
  };

  // Simple array diff function
  Array.prototype.diff = function(a) {
    return this.filter(function(i) { return (a.indexOf(i) > -1) === false; });
  };

  // Update the user profile when logging in
  EveSeat.updateProfile = function(uid, profile, callback) {
    async.waterfall([
      function (next) {
        user.setUserField(uid, 'fullname', profile.characterName, next);
      },
      function (next) {
        user.setUserField(uid, 'uploadedpicture', profile.characterPortrait, next);
      },
      function (next) {
        user.setUserField(uid, 'picture', profile.characterPortrait, next);
      },
      function (next) {
        if (EveSeat.settings.mapRoles === 'on') {
          EveSeat.syncUserGroups(uid, profile.roles, next);
        } else {
          next();
        }
      }
    ], callback);
  };

  // Syncs roles to forum groups
  EveSeat.syncUserGroups = function(uid, roles, callback) {
    async.parallel({
      groupMappings: function(next) {
        getAllGroupMappings(next);
      },
      userGroups: function(next) {
        Groups.getUserGroupsFromSet('groups:createtime', [uid], next);
      }
    },
    function(err, results) {
      winston.verbose('[plugin-sso-eveseat] Roles: ' + roles);

      var rolesGroupSlugs = [];
      var currentGroupSlugs = [];

      // Profile roles to group mapping
      roles.forEach(function(roleName) {
        results.groupMappings.forEach(function(groupMapping) {
          if (groupMapping.roleName === roleName) {
            rolesGroupSlugs.push(groupMapping.groupSlug);
          }
        });
      });

      // Current user Groups
      results.userGroups[0].forEach(function(group) {
        if (!Groups.isPrivilegeGroup(group.name) && group.name !== 'registered-users') {
          currentGroupSlugs.push(group.slug);
        }
      });

      // Diff groups
      var groupsToLeave = currentGroupSlugs.diff(rolesGroupSlugs);
      var groupsToJoin = rolesGroupSlugs.diff(currentGroupSlugs);

      if (groupsToLeave.length > 0) {
        winston.verbose('[plugin-sso-eveseat] Leaving Groups: ' + groupsToLeave);

        // Leave Groups
        groupsToLeave.forEach(function(groupSlug) {
          Groups.getGroupNameByGroupSlug(groupSlug, function(err, groupName) {
            if (groupName) {
              Groups.leave(groupName, uid);
            }
          });
        });
      }

      if (groupsToJoin.length > 0) {
        winston.verbose('[plugin-sso-eveseat] Joining Groups: ' + groupsToJoin);

        // Join Groups
        groupsToJoin.forEach(function(groupSlug) {
          Groups.getGroupNameByGroupSlug(groupSlug, function(err, groupName) {

            if (groupName) {
              Groups.join(groupName, uid);
            }
          });
        });
      }

      callback();
    });
  };

  // Store Tokens for future use
  EveSeat.storeTokens = function(uid, accessToken, refreshToken) {
    winston.verbose('[plugin-sso-eveseat] Storing received eveseat access information for uid(' + uid + ') accessToken(' + accessToken + ') refreshToken(' + refreshToken + ')');

    user.setUserField(uid, 'eveseataccesstoken', accessToken);
    user.setUserField(uid, 'eveseatrefreshtoken', refreshToken);
  };

  // Get UID
  EveSeat.getUidByEveSeatId = function(eveseatid, callback) {
    db.getObjectField('eveseatid:uid', eveseatid, function(err, uid) {
      if (err) {
        return callback(err);
      }

      callback(null, uid);
    });
  };

  // Hook to delete user data when user is deleted
  EveSeat.deleteUserData = function(uid, callback) {
    async.waterfall([
      async.apply(user.getUserField, uid.uid, 'eveseatid'),
        function(oAuthIdToDelete, next) {
          winston.verbose('[plugin-sso-eveseat] Deleting OAuthId data for uid ' + uid.uid + '. oAuthIdToDelete: ' + oAuthIdToDelete);

          db.deleteObjectField('eveseatid:uid', oAuthIdToDelete, next);
      	}
    ], function(err) {
      if (err) {
        winston.verbose('[plugin-sso-eveseat] Could not remove OAuthId data for uid ' + uid.uid + '. Error: ' + err);

        return callback(err);
      }

      callback(null, uid);
    });
  };

  // Get association for account screen
  EveSeat.getAssociation = function(data, callback) {
    user.getUserField(data.uid, 'eveseatid', function(err, eveSeatId) {
      if (err) {
        return callback(err, data);
      }

      if (eveSeatId) {
        data.associations.push({
          associated: true,
          url: EveSeat.settings.baseUri,
          name: EveSeat.settings.frontendName || constants.name,
          icon: constants.admin.icon
        });
      } else {
        data.associations.push({
          associated: false,
          url: nconf.get('url') + '/auth/eveseat',
          name: EveSeat.settings.frontendName || constants.name,
          icon: constants.admin.icon
        });
      }

      callback(null, data);
    });
  };

  // Socket to delete group mapping
  EveSeat.createGroupMapping = function(socket, data, callback) {
    createGroupMapping(data, callback);
  };

  // Socket to delete group mapping
  EveSeat.deleteGroupMapping = function(socket, mappingId, callback) {
    deleteGroupMapping(mappingId, callback);
  };

  // Socket to get all group mappings
  EveSeat.getAllGroupMappings = function(socket, data, callback) {
    getAllGroupMappings(callback);
  };

  // Create group mapping
  function createGroupMapping(data, callback) {
    if (!data || !data.hasOwnProperty('roleName') || data.roleName === '' || !data.hasOwnProperty('groupSlug') || data.groupSlug === '') {
      return callback(new Error('empty-data'));
    }

    db.incrObjectField('global', 'nextEveSeatMappingId', function(err, mappingId) {
      if (err) {
        return callback(err);
      }

      var mapping = {
        mappingId: mappingId,
        roleName: data.roleName,
        groupSlug: data.groupSlug
      };

      async.parallel({
        mappingId: function(next) {
          db.setObject('plugin-sso-eveseat:group-mapping:' + mappingId, mapping, next(err, mappingId));
        },
        whatever : function(next) {
          db.setAdd('plugin-sso-eveseat:group-mappings', mappingId, next(err, mappingId));
        }
      }, callback);
    });
  }

  // Removed group mapping data
  function deleteGroupMapping(mappingId, callback) {
    async.parallel([
      function(next) {
        db.setRemove('plugin-sso-eveseat:group-mappings', mappingId, next);
      },
      function(next) {
        db.delete('plugin-sso-eveseat:group-mapping' + mappingId, next);
      }
    ], callback);
  }

  // Get all group mapping data
  function getAllGroupMappings(callback) {
    db.getSetMembers('plugin-sso-eveseat:group-mappings', function(err, mappingIds) {
      var mappings = [];

      async.each(mappingIds, function(mappingId, next) {
        db.getObject('plugin-sso-eveseat:group-mapping:' + mappingId, function(err, mapping) {
          Groups.getGroupNameByGroupSlug(mapping.groupSlug, function(err, groupName) {

            // Group for mapping not found, remove the mapping
            if (err || !groupName) {
              deleteGroupMapping(mapping.mappingId, null);

            // Set groupName
            } else {
              mapping.groupName = groupName;
              mappings.push(mapping);
            }

            next();
          });
        });
      }, function(err) {
        callback(err, mappings);
      });
    });
  }

  module.exports = EveSeat;

}(module));