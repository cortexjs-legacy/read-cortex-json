'use strict';

var util = require('util');
var async = require('async');
var fs = require('fs');
var node_path = require('path');

var SUPPORTED_DIRS = [
  'src',
  'dist'
];

// Validate pkg data for a specified `cwd`
// TODO: split every test as an option
exports.validate = function (cwd, pkg, callback) {
  var name = pkg.name;
  if (name.toLowerCase() !== name) {
    return done({
      code: 'ERROR_UPPER_NAME',
      message: 'package.name should not contain uppercased letters.',
      data: {
        name: name
      }
    });
  }

  var directories = pkg.directories;
  // However we should tell user to stop using `directories.css`,
  // which will removed in the next major.
  if (directories && ('css' in directories)) {
    return callback({
      code: 'NO_SUPPORT_DIR_CSS',
      message: 'Cortex will no longer support `cortex.directories.css` since 4.0.0,\n'
        + 'use `cortex.css` instead.'
    });
  }

  var dirs = directories
    ? Object.keys(directories)
    : [];
  var supported = dirs.every(function (dir) {
    if (~SUPPORTED_DIRS.indexOf(dir)) {
      return true;
    }

    callback({
      code: 'NO_SUPPORT_DIR',
      message: '`directories.' + dir + '` is not supported.',
      data: {
        dir: dir
      }
    });
  });

  if (!supported) {
    return;
  }
  
  var items = dirs.map(function (dir) {
    return {
      path: node_path.join(cwd, dir),
      type: 'isDirectory',
      error: {
        code: 'DIR_NOT_FOUND',
        message: '`directories.' + dir + '` is defined, but not found.',
        data: {
          dir: dir
        }
      }
    };
  });
  var css = pkg.css;
  if (css) {
    css = css.map(function (path) {
      return {
        path: node_path.join(cwd, path),
        type: 'isFile',
        error: {
          code: 'CSS_NOT_FOUND',
          message: '`pkg.css` is defined, but "' + path + '" is not found.',
          data: {
            file: path
          }
        }
      };
    });
    items = items.concat(css);
  }

  // Make sure `directories` and `css` exist
  async.each(items, exports._test_path, callback);
};


exports._test_path = function (obj, done) {
  fs.stat(obj.path, function (err, stat) {
    if (err || !stat[obj.type]()) {
      return done(obj.error);
    }
    done(null);
  });
};


// Check the existence of cortex.main
// if not exists, pkg.main will be deleted.
exports.clean_pkg_main = function (cwd, pkg, callback) {
  var main = pkg.main;
  var index = 'index.js';
  var name_js = pkg.name + '.js';
  var parsed;

  function cb (parsed) {
    if (parsed) {
      // `require.resolve` is really weird that it will change the path of temp directory.
      // The situation below might happen:
      // ```
      // var a = '/var/folders/xxxxxx'
      // var b = require.resolve(a); // -> /private/var/folders/xxxxx.js
      // ```
      var index = parsed.indexOf(cwd);
      if (~index) {
        // b -> '/var/folders/xxxxx.js'
        parsed = parsed.slice(index);
      }
      // './index.js' -> '/path/to/index.js' -> 'index.js'
      pkg.main = node_path.relative(cwd, parsed);
    } else {
      // `pkg` might has a prototype, so we can't remove a key by deleting them.
      // set it to undefined, `JSON.stringify()` will ignore it.
      pkg.main = undefined;
    }
    callback(null, pkg);
  }

  if (main) {
    parsed = exports._test_file(cwd, main);
    if (!parsed) {
      return callback({
        code: 'MAIN_NOT_FOUND',
        message: '`cortex.main` is defined as "' + main + '", but not found.',
        data: {
          main: main
        }
      });
    }
    return cb(parsed);
  }

  parsed = exports._test_file(cwd, index) 
    // fallback to <name>.js
    || exports._test_file(cwd, name_js);
  cb(parsed);
};


exports.clean_pkg_entries = function (cwd, pkg, callback) {
  exports._clean_items(cwd, pkg, 'entries', callback);
};


exports.clean_pkg_css = function (cwd, pkg, callback) {
  exports._clean_items(cwd, pkg, 'css', callback);
};


// @param {string} key
exports._clean_items = function (cwd, pkg, key, callback) {
  var KEY = key.toUpperCase();
  exports._expand_items(cwd, pkg[key], function (err, files) {
    if (err) {
      if (err.code === 'NOT_FOUND') {
        return callback({
          code: 'CORTEX_' + KEY + '_NOT_FOUND',
          message: 'The files defined in `cortex.' + key + '`, but not found:\n'
            + err.data.not_found.map(function (file) {
              return '   - ' + file;
            }).join('\n'),
          data: err.data
        });
      }
      return callback(err);
    }
    pkg[key] = files;
    callback(null);
  });
};


exports._expand_items = function (cwd, value, callback) {
  if (!value) {
    // #8
    // standardize `pkg.css` and make sure it is always an array.
    return callback(null, []);
  }

  value = util.isArray(value)
    ? value
    : [value];

  var glob_patterns = [];
  var explicit_paths = [];
  value.forEach(function (v) {
    if (~v.indexOf('*')) {
      glob_patterns.push(v);
    } else {
      explicit_paths.push(v);
    }
  });

  var tasks = [];
  var found = [];
  var globbed = [];
  if (glob_patterns.length) {
    tasks.push(function (done) {
      expand(glob_patterns, {
        cwd: cwd
      }, function (err, files) {
        if (err) {
          return done(err);
        }
        globbed = files;
        done(null);
      });
    });
  }

  if (explicit_paths.length) {
    tasks.push(function (done) {
      exports._check_multi_exists(cwd, explicit_paths, function (not_found) {
        if (not_found.length) {
          return done({
            code: 'NOT_FOUND',
            data: {
              not_found: not_found
            }
          });
        }
        found = explicit_paths.map(function (path) {
          // './pages/a.js' -> 'pages/a.js'
          return node_path.join('.', path);
        });
        done(null);
      });
    });
  }

  async.parallel(tasks, function (err) {
    // `globbed.length` is larger usually
    callback(err, globbed.concat(found));
  });
};


// @param {function(not_found)}
exports._check_multi_exists = function (cwd, paths, callback) {
  var not_found = [];
  async.each(paths, function (path, done) {
    var absolute = node_path.join(cwd, path);
    // We only check the existance of the file,
    // because we only gives "enough" hints for people who makes a mistake,
    // but never cares about the situation user deliberately break something.
    fs.exists(absolute, function (exists) {
      if (!exists) {
        not_found.push(path);
      }
      // there will be no errors.
      done(null);
    });
  }, function () {
    callback(not_found);
  });
};
