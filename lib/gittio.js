var path = require('path'),
  config = require('./config'),
  alloy = require('./alloy'),
  component = require('./component'),
  dist = require('./dist'),
  tiapp = require('./tiapp'),
  exec = require('./exec'),
  rimraf = require('rimraf'),
  logger = require('./logger'),
  _ = require('underscore'),
  fs = require('fs-extra'),
  utils = require('./utils'),
  async = require('async');

function uninstall(o) {

  if (o.version === '*') {
    delete o.version;
  }

  if (!_uninstallWidget(o)) {
    _uninstallModule(o);
  }
}

function _uninstallWidget(o) {
  if (config.context === 'global' || !fs.existsSync(config.widgets_path)) {
    return false;
  }
  var trgPath = path.join(config.widgets_path, o.id);
  var files = fs.readdirSync(config.widgets_path);
  var found = _.find(files, function(f) {
    return f === o.id;
  });
  var installed = found && (o.version === undefined || require(path.join(trgPath, 'widget.json')).version === o.version);
  var prefix = utils.prefix(o.id, o.version);
  if (installed) {
    rimraf.sync(trgPath);
    alloy.dropDependency(o.id, o.version);

    logger.info(prefix + ' uninstalled');

    return true;
  } else {
    found = _.find(files, function(f) {
      return f.toLowerCase() === o.id.toLowerCase();
    });
    if (found) {
      logger.error("Did you mean " + found + "?");
      return true;
    }
  }

  return false;
}

function _uninstallModule(o) {
  var trgPath = o.global ? config.global_modules_path : path.join(config.modules_path);
  var platform = (o.platform ? o.platform.replace("ios", "iphone") : undefined);
  var uninstalled = false;

  if (config.context === "project") {
    tiapp.dropDependency(o.id, o.version, platform);
  }

  if (o.global || config.context !== "project") {
    _.pairs(config.available_modules.global).forEach(function(kv) {
      var platform = kv[0],
        platform_modules = kv[1];
      if (o.platform === undefined || o.platform == platform) {
        _.pairs(platform_modules).forEach(function(kv) {
          var id = kv[0],
            id_modules = kv[1];
          if (o.id === id) {
            _.pairs(id_modules).forEach(function(kv) {
              var version = kv[0],
                module = kv[1];
              if (o.version === undefined || o.version === version) {
                var modulePath = path.join(module.modulePath);
                if (fs.existsSync(modulePath)) {
                  rimraf.sync(path.join(module.modulePath));
                  uninstalled = true;
                }
              }
            });
          }
        });
      }
    });
  } else {
    config.current_modules.map(function(m) {
      if (m.name === o.id &&
        (o.version === undefined || o.version === m.version) &&
        (platform === undefined || platform === m.platform)) {
        tiapp.dropDependency(o.id, o.version, platform);
        var modulePath = path.join(trgPath, m.platform, m.name);
        if (fs.existsSync(modulePath)) {
          rimraf.sync(modulePath);
          uninstalled = true;
        }
      }
    });
  }

  var prefix = utils.prefix(o.id, o.version);

  if (uninstalled) {
    logger.info(prefix + ' uninstalled');
  } else {
    logger.warn(prefix + ' not installed');
  }
}

function install(o) {

  if (o.version === '*') {
    delete o.version;
  }

  if (o.id) {
    return _installSingle(o);
  } else {
    if (config.context === "global") {
      if (o.update && o.type !== "widget") {
        return _installAllModules(o);
      } else {
        logger.error("This command must be executed from a project directory");
        return;
      }
    }
    if (o.type === 'widget') {
      return _installAllWidgets(o);
    } else if (o.type === 'module') {
      return _installAllModules(o);
    } else {
      return _installAll(o);
    }
  }
}

function _addDependency(cmp, dst, o) {
  if (cmp.type === 'module' && config.context === 'project') {
    tiapp.addDependency(cmp.id, o.version, dst.platforms);
  } else if (cmp.type === 'widget') {
    alloy.addDependency(cmp.id, o.version);
  }
}

function _installSingle(o) {

  component.lookup(o.id, function(err, cmp) {

    if (err) {
      logger.error(err);
      return;
    }

    if (cmp.type === 'widget' && !config.isAlloy) {
      logger.error('Widgets must be installed within an Alloy project directory.');
      return;
    }

    // filter all dists
    var dists = component.filterDists(cmp, o);

    // nothing to install
    if (dists.length === 0) {
      return;
    }

    // for all dists
    _.each(dists, function(dst) {
      var prefix = utils.prefix(cmp.id, dst.version, dst.platforms),
        installed = dist.isInstalled(cmp, dst, o);

      // already installed
      if (installed && !o.force) {
        logger.warn(prefix + ' already installed');

        // add dependency
        _addDependency(cmp, dst, o);

      } else {

        // download
        logger.info(prefix + ' downloading...');

        dist.download(dst.dist, function(err, tmpPath) {

          if (err) {
            logger.error(err);
            return;
          }

          logger.info(prefix + ' installing...');

          // create trgPath
          fs.mkdirs(dst.trgPath, function(err) {

            if (err) {
              logger.error(err);
              return;
            }

            // copy from tmpPath
            fs.copy(path.join(tmpPath, dst.srcPath), dst.trgPath, function(err) {

              if (err) {
                logger.error(err);
                return;
              }

              // add dependency
              _addDependency(cmp, dst, o);

              // recursive widget dependencies
              if (cmp.type === 'widget') {
                var widget = require(path.join(dst.trgPath, 'widget.json'));

                // include our self-declared 'modules' dependencies
                var dependencies = _.extend({}, widget.dependencies || {}, widget.modules || {});

                if (_.size(dependencies) > 0) {
                  var tasks = _.pairs(dependencies).map(function(kv) {
                    var id = kv[0],
                      version = kv[1];

                    return function() {
                      install(_.defaults({
                        id: id,
                        version: version
                      }, o));
                    };

                  });

                  // install dependencies
                  if (tasks.length > 0) {
                    async.parallel(tasks, function() { console.log('done');});
                  }
                }
              }

              // remove tmpPath
              rimraf.sync(tmpPath);

              logger.info(prefix + ' installed');
            });
          });
        });
      }
    });
  }, {
    action: o.update ? 'update' : 'install'
  });
}

function _installAll(o) {
  async.parallel([
    _.bind(_installAllWidgets, undefined, o),
    _.bind(_installAllModules, undefined, o)
  ]);
}

function _installAllWidgets(o) {

  if (config.isAlloy) {
    var data = config.alloy_config;

    if (data.dependencies && _.size(data.dependencies) > 0) {
      var tasks = [];

      _.each(data.dependencies, function(version, widget) {
        tasks.push(function() {
          install(_.extend({
            id: widget,
            version: o.update ? undefined : version
          }, o));
        });
      });

      async.parallel(tasks);

    } else {
      logger.warn('no widgets found to ' + (o.update ? 'update' : 'install'));
    }
  }
}

function _installAllModules(o) {
  var tasks;
  if (config.context === "project") {
    tasks = config.current_modules.map(function(m) {
      return function() {
        install(_.defaults({
          id: m.name,
          version: o.update ? undefined : m.version,
          platform: m.platform.replace("iphone", "ios")
        }, o));
      };
    });
  } else {
    tasks = [];
    _.pairs(config.available_modules.global).forEach(function(kv) {
      var platform = kv[0],
        platform_modules = kv[1];
      _.pairs(platform_modules).forEach(function(kv) {
        var id = kv[0],
          id_modules = kv[1];
        tasks.push(function() {
          install(_.defaults({
            id: id,
            platform: platform.replace("iphone", "ios")
          }, o));
        });
      });
    });
  }
  if (tasks.length > 0) {
    async.parallel(tasks);
  } else {
    logger.warn('no modules found to ' + (o.update ? 'update' : 'install'));
  }
}

function info(id, options) {
  component.lookup(id, function(err, info) {
    if (err) {
      if (options.output === "json") {
        console.log(JSON.stringify({
          error: err
        }));
      } else {
        logger.error(err);
      }
      return;
    }
    if (options.output === "json") {
      console.log(JSON.stringify(info, null, '  '));
    } else {
      utils.prettyJSON(info);
      console.log('');
    }
  }, {
    silent: options.output === "json",
    action: 'info'
  });
}

function demo(o) {
  var project_path = path.join(process.cwd(), o.id);

  if (config.context === 'project') {
    logger.error('you should not have me create: ' + project_path);
    return;
  }

  if (fs.existsSync(project_path)) {
    logger.error('cannot create already existing: ' + project_path);
    return;
  }

  component.lookup(o.id, function(err, cmp) {

    if (err) {
      logger.error(err);
      return;
    }

    if (cmp.type !== 'module') {
      logger.error('demo only works with modules.');
      return;
    }

    console.log('');
    console.log('--- CREATING PROJECT ---');
    console.log('');

    // create project
    exec('ti', ['create', '-p', cmp.platforms.join(','), '-n', cmp.id, '--id', cmp.id, '-d', process.cwd()], null, function() {

      console.log('--- INSTALLING MODULE ---');
      console.log('');

      // install module
      exec('gittio', ['install', cmp.id + (o.version ? '@' + o.version : '')], {
        cwd: project_path
      }, function() {

        console.log('');
        console.log('--- PREPARING EXAMPLES ---');
        console.log('');

        var build = null;

        // for each platform
        _.each(cmp.platforms, function(platform) {

          if (platform === 'ios') {
            platform = 'iphone';
          }

          var module_path = path.join(project_path, 'modules', platform, cmp.id);
          var version = fs.readdirSync(module_path)[0];
          var example_path = path.join(module_path, version, 'example');

          // no example
          if (!fs.existsSync(path.join(example_path, 'app.js'))) {
            logger.warn('No example for ' + platform);
            return;
          }

          logger.info('Copied example for ' + platform);

          // copy example
          fs.copySync(example_path, path.join(project_path, 'Resources', platform));

          build = build || platform;
        });

        // no examples
        if (!build) {
          logger.error('No examples found.');
          return;
        }

        console.log('');
        console.log('--- BUILDING PROJECT ---');
        console.log('');

        // build first platform
        exec('ti', ['build', '-p', build], {
          cwd: project_path
        });
      });
    });
  }, {
    action: 'demo'
  });
}

exports.install = install;
exports.uninstall = uninstall;
exports.info = info;
exports.demo = demo;