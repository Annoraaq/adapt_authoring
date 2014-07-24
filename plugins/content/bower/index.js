/**
 * Bower content plugin
 *
 * The bower plugin is a bit more complex than other content plugins,
 * since it needs to manage any kind of adapt component that has been
 * published to our bower repository. This module is intended to be inherited
 * and extended by the various bower content plugins (components, extensions, themes)
 */

var origin = require('../../../'),
    contentmanager = require('../../../lib/contentmanager'),
    rest = require('../../../lib/rest'),
    ContentPlugin = contentmanager.ContentPlugin,
    ContentTypeError = contentmanager.errors.ContentTypeError,
    configuration = require('../../../lib/configuration'),
    database = require('../../../lib/database'),
    logger = require('../../../lib/logger'),
    defaultOptions = require('./defaults.json'),
    bower = require('bower'),
    rimraf = require('rimraf'),
    async = require('async'),
    semver = require('semver'),
    fs = require('fs'),
    ncp = require('ncp').ncp,
    mkdirp = require('mkdirp'),
    _ = require('underscore'),
    util = require('util'),
    path = require('path');

function BowerPlugin () {
}

util.inherits(BowerPlugin, ContentPlugin);

/**
 * implements ContentObject#getModelName
 *
 * @return {string}
 */
BowerPlugin.prototype.getModelName = function () {
  return false;
};

/**
 * returns the plugin type identifier for this plugin
 *
 * @return {string}
 */
BowerPlugin.prototype.getPluginType = function () {
  return false;
};

/**
 * returns the child type for this object
 *
 * @return string
 */
BowerPlugin.prototype.getChildType = function () {
  return false; // no children evAr!
};

/**
 * add content schema to the database via this function
 *
 * @param {object} db
 */
BowerPlugin.prototype.onDatabaseCreated = function (db) {
  var modelName = this.getModelName();
  var pluginType = this.getPluginType();
  if (!modelName || !pluginType) {
    return;
  }

  var schemaPath = path.join(configuration.serverRoot, 'plugins', 'content', modelName, pluginType + '.schema');
  try {
    var schema = fs.readFileSync(schemaPath);
    schema = JSON.parse(schema);
    db.addModel(pluginType, schema);
  } catch (error) {
    logger.log('error', 'failed to parse schema file at ' + schemaPath, error);
  }
};

/**
 * returns the package type managed by this plugin (component, theme, etc)
 *
 */
BowerPlugin.prototype.getPackageType = function () {
  return false;
};

/**
 * extracts the necessary attributes to store a package in the DB
 *
 */
function extractPackageInfo (plugin, pkgMeta, schema) {
  // build package info
  var info = {
    name: pkgMeta.name,
    displayName: pkgMeta.displayName,
    description: pkgMeta.description,
    version: pkgMeta.version,
    properties: schema.properties
  };

  // set the type and package id for the package
  info[plugin.packageType] = pkgMeta[plugin.packageType];

  return info;
}

/**
 * essential setup
 *
 */
BowerPlugin.prototype.initialize = function (plugin) {
  var app = origin();
  app.once('serverStarted', function (server) {
    // add componenttype list route
    rest.get('/' + plugin.type, function (req, res, next) {
      var options = _.extend(plugin.options, _.pick(req.query, 'refreshplugins', 'showall'));
      fetchInstalledPackages(plugin, options,function (err, results) {
        if (err) {
          return next(err);
        }

        // only send the latest version of the packages
        var packages = {};
        async.eachSeries(results, function (item, cb) {
          if (!req.query.showall && !item._isAvailableInEditor) {
            return cb(null);
          }

          if ('object' !== typeof packages[item.name]) {
            packages[item.name] = item;
          } else if (semver.lt(packages[item.name].version, item.version)) {
            packages[item.name] = item;
          }

          cb(null);
        },
        function (err) {
          if (err) {
            return next(err);
          }

          return res.json(_.values(packages));
        });
      });
    });

    // get a single pluginType definition by id
    rest.get('/' + plugin.type + '/:id', function (req, res, next) {
      database.getDatabase(function (err, db) {
        if (err) {
          return next(err);
        }

        db.retrieve(plugin.type, { _id: req.params.id }, function (err, results) {
          if (err) {
            return next(err);
          }

          // want to return one only
          if (results && 1 === results.length) {
            return res.json(results[0]);
          }

          res.statusCode = 404;
          return res.json({ success: false, message: 'could not find plugin' });
        });
      });
    });

    // update a single plugin type definition by id
    rest.put('/' + plugin.type + '/:id', function (req, res, next) {
      var delta = _.pick(req.body, '_isAvailableInEditor'); // only allow update of certain attributes
      database.getDatabase(function (err, db) {
        if (err) {
          return next(err);
        }

        db.update(plugin.type, { _id: req.params.id }, delta, function (err) {
          if (err) {
            return next(err);
          }

          return res.json({ success: true });
        });
      });
    });

    // check if a higher version is available for the plugin
    rest.get('/' + plugin.type + '/checkversion/:id', function (req, res, next) {
      database.getDatabase(function (err, db) {
        if (err) {
          return next(err);
        }

        db.retrieve(plugin.type, { _id: req.params.id }, function (err, results) {
          if (err) {
            return next(err);
          }

          if (!results || 1 !== results.length) {
            res.statusCode = 404;
            return res.json({ success: false, message: 'could not find plugin' });
          }

          checkIfHigherVersionExists(results[0], plugin.options, function (err, exists) {
            return res.json({ success:true, isUpdateable: exists });
          });
        });
      });
    });

    // upgrade a plugin/plugins
    rest.post('/' + plugin.type + '/update', function (req, res, next) {
      var upgradeTargets = req.body.targets;
      if (!util.isArray(upgradeTargets)) {
        res.statusCode = 400;
        return res.json({ success: false, message: 'targets parameter should be an array' });
      }

      database.getDatabase(function (err, db) {
        if (err) {
          return next(err);
        }

        db.retrieve(plugin.type, { _id: { $in: upgradeTargets} }, function (err, results) {
          if (err) {
            return next(err);
          }

          if (!results || 0 === results.length) {
            res.statusCode = 404;
            return res.json({ success: false, message: 'could not find plugin(s)' });
          }

          async.map(
            results,
            function (item, cb) {
              return cb(null, item.name);
            },
            function (err, pluginNames) {
              if (err) {
                return next(err);
              }

              // bower throws a fit if passing an array of size 1 :\
              if (pluginNames.length === 1) {
                pluginNames = pluginNames[0];
              }

              var options = _.extend(
                plugin.options,
                { _searchItems: pluginNames }
              );

              return updatePackages(plugin, options, function () {
                // @TODO figure out how to determine if the update failed?
                return res.json({ success: true, upgraded: upgradeTargets });
              });
            });
        });
      });
    });
  });
}

/**
 * this will retrieve a list of bower plugins that have been installed on the system
 * if there are no plugins, it will make a single attempt to install them
 * and then send the list via the callback
 *
 * @param {object} [options] {refresh: int, retry: boolean}
 * @param {callback} cb
 */
function fetchInstalledPackages (plugin, options, cb) {
  // shuffle params
  if ('function' === typeof options) {
    cb = options;
    options = {};
  }

  options = _.extend({
      retry: true
    }, defaultOptions, options);

  database.getDatabase(function (err, db) {
    if (err) {
      return cb(err);
    }

    db.retrieve(plugin.type, {}, function (err, results) {
      if (err) {
        return cb(err);
      }

      // there should be at least one installed
      if (options.refreshplugins || ((!results || 0 === results.length) && options.retry)) {
        // update plugins retry, return
        return updatePackages(plugin, options, function (err) {
          if (err) {
            return cb(err);
          }

          // try again, but only once
          options.retry = false;
          options.refreshplugins = false;
          fetchInstalledPackages(plugin, options, cb);
        });
      }

      return cb(null, results);
    });
  });
}

/**
 * adds a new package to the system - fired after bower
 * has installed to the cache
 *
 * @param {object} packageInfo - the bower package info retrieved during install
 * @param {callback} cb
 */
function addPackage (plugin, packageInfo, cb) {
  // verify packageInfo meets requirements
  var pkgMeta = packageInfo.pkgMeta;
  if (pkgMeta.keywords) { // only allow our package type
    var keywords = _.isArray(pkgMeta.keywords) ? pkgMeta.keywords : [pkgMeta.keywords];
    if (!_.contains(keywords, plugin.keywords)) {
      logger.log('info', 'ignoring unsupported package: ' + pkgMeta.name);
      return cb(null);
    }
  } else {
    logger.log('warn', 'ignoring component without keywords defined: ' + pkgMeta.name);
    return cb(null);
  }

  if (!pkgMeta.version) { // don't allow packages that don't define versions
    /*
    * @TODO: Re-implement this once properties.schema files make it to master!
    logger.log('warn', 'ignoring unversioned component: ' + pkgMeta.name);
    return cb(null);
    */
    pkgMeta.version = "0.2.0"; // Remove me later - see above ^
  }

  var schemaPath = path.join(packageInfo.canonicalDir, defaultOptions._adaptSchemaFile);
  fs.exists(schemaPath, function (exists) {
    if (!exists) {
      logger.log('warn', 'ignoring package with no schema: ' + pkgMeta.name);
      return cb(null);
    }

    fs.readFile(schemaPath, function (err, data) {
      var schema = false;
      if (err) {
        // don't error out, just notify
        logger.log('error', 'failed to parse schema for ' + pkgMeta.name, err);
        return cb(null);
      }

      try {
        schema = JSON.parse(data);
      } catch (e) {
        // don't error out, just notify
        logger.log('error', 'failed to parse schema for ' + pkgMeta.name, e);
        return cb(null);
      }

      // Copy this version of the component to a holding area (used for publishing).
      // Folder structure: <versions folder>/adapt-contrib-graphic/0.0.2/adapt-contrib-graphic/...
      var destination = path.join(plugin.options.versionsFolder, pkgMeta.name, pkgMeta.version, pkgMeta.name);
      fs.exists(destination, function(exists) {
        if (!exists) {
          mkdirp(destination, function (err) {
            if (err) {
              return cb(err);
            }

            // move from the cache to the versioned dir
            ncp(packageInfo.canonicalDir, destination, function (err) {
              if (err) {
                return cb(err);
              }
            });
          });
        }
      });

      // build the package information
      var package = extractPackageInfo(plugin, pkgMeta, schema);

      // add the package to the modelname collection
      database.getDatabase(function (err, db) {
        if (err) {
          return cb(err);
        }

        // don't duplicate component.name, component.version
        db.retrieve(plugin.type, { name: package.name, version: package.version }, function (err, results) {
          if (err) {
            return cb(err);
          }

          if (results && 0 !== results.length) {
            // don't add duplicate
            return cb(null);
          }

          db.create(plugin.type, package, function (err, results) {
            if (err) {
              // don't error out if we didn't add the component, just notify
              logger.log('error', 'Failed to add package: ' + package.name, err);
              return cb(null);
            }
            logger.log('info', 'Added package: ' + package.name);
            return cb(null, results);
          });
        });
      });
    });
  });
}

/**
 * this function uses bower to search and install new adapt framework
 * packages to the authoring tool
 *
 * @param {object} options - bower configuration and local config options
 * @param {callback} cb
 */
function updatePackages (plugin, options, cb) {
  // shuffle params
  if ('function' === typeof options) {
    cb = options;
    options = {
      '_searchItems': ''
    };
  }

  options = _.extend(
    defaultOptions,
    options
  );

  // log the update with any passed options
  logger.log('info', 'updating packages', options);

  // update directory relative to server location
  options.cwd = configuration.serverRoot;

  // clean our bower cache
  rimraf(options.directory, function (err) {
    if (err) {
      return cb(err);
    }

    // now do search and install
    bower.commands
      .search(options._searchItems, options)
      .on('error', cb)
      .on('end', function (results) {
        // lets bower install each
        async.map(results,
          function (item, next) {
            next(null, item.name);
          },
          function (err, nameList) {
            nameList = plugin.nameList; // TODO - remove when components/extensions are up to date
            bower
              .commands
              .install(nameList, { save: true }, options)
              .on('error', cb)
              .on('end', function (packageInfo) {
                // add details for each to the db
                async.eachSeries(
                  Object.keys(packageInfo),
                  function (key, next) {
                    addPackage(plugin, packageInfo[key], next);
                  },
                  cb);
              });
          });
      });
  });
}

/**
 * checks if a higher version of an installed extension is available
 *
 */
function checkIfHigherVersionExists (package, options, cb) {
  // shuffle params
  if ('function' === typeof options) {
    cb = options;
    options = {};
  }

  options = _.extend(
    defaultOptions,
    options
  );

  bower
    .commands
    .install([package.name+'#develop'], null, options) // @TODO - remove develop tag!
    .on('end', function (info) {
      // if info is empty, it means there is no higher version of the plugin available
      if (!info.pkgMeta) {
        return cb(null, false);
      }
      return cb(null, true);
    });
}

/**
 * Module exports
 *
 */

exports = module.exports = BowerPlugin;
