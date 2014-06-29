'use strict';

var cleaner = exports;

var util = require('util');
var async = require('async');
var fs = require('fs');
var node_path = require('path');


cleaner.clean = function (cwd, pkg, callback) {
  var name = pkg.name;
  if (name.toLowerCase() !== name) {
    return callback({
      code: 'ERROR_UPPER_NAME',
      message: '`cortex.name` should not contain uppercased letters.',
      data: {
        name: name
      }
    });
  }

  async.each([
    'check_dirs',
    'clean_pkg_css',
    'clean_pkg_main',
    'clean_pkg_entries'
  ], function (task, done) {
    cleaner[task](cwd, pkg, done);

  }, function (err) {
    if (err) {
      return callback(err);
    }

    cleaner.check_entry(pkg, callback);
  });
};


// Cortex must be something to export
cleaner.check_entry = function (pkg, callback) {
  if (!pkg.main && !pkg.css.length && !pkg.entries.length) {
    return callback({
      code: 'CORTEX_NO_ENTRY',
      message: [
        'A package must do something. At least of the 3 fields should be defined and existing:',
        '   - `cortex.main`   : it could be `require()`d',
        '   - `cortex.css`    : the css file(s) could be depent by other packages',
        '   - `cortex.entries`: could be accessed with `facade()`.'
      ].join('\n')
    });
  }
  callback(null, pkg);
};


// For now, we only support two dirs
var SUPPORTED_DIRS = [
  'src',
  'dist'
];

// Checks `cortex.directories`
cleaner.check_dirs = function (cwd, pkg, callback) {
  var directories = pkg.directories;
  var dirs = directories
    ? Object.keys(directories)
    : [];

  var supported = dirs.every(function (dir) {
    if (~SUPPORTED_DIRS.indexOf(dir)) {
      return true;
    }

    if (dir === 'css') {
      // However we should tell user to stop using `directories.css`
      callback({
        code: 'NO_SUPPORT_DIR_CSS',
        message: 'Cortex will no longer support `cortex.directories.css` since 4.0.0,\n'
          + 'use `cortex.css` instead.'
      });
    } else {
      callback({
        code: 'NO_SUPPORT_DIR',
        message: '`directories.' + dir + '` is not supported.',
        data: {
          dir: dir
        }
      });
    }

    return false;
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

  // Make sure `directories` and `css` exist
  async.each(items, cleaner._test_path, callback);
};


cleaner._test_path = function (obj, callback) {
  fs.stat(obj.path, function (err, stat) {
    if (err || !stat[obj.type]()) {
      return callback(obj.error);
    }
    callback(null);
  });
};


// Check the existence of cortex.main
// if not exists, pkg.main will be deleted.
cleaner.clean_pkg_main = function (cwd, pkg, callback) {
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
    parsed = cleaner._test_file(cwd, main);
    if (!parsed) {
      return callback({
        code: 'CORTEX_MAIN_NOT_FOUND',
        message: '`cortex.main` is defined as "' + main + '", but not found.',
        data: {
          main: main
        }
      });
    }
    return cb(parsed);
  }

  parsed = cleaner._test_file(cwd, index) 
    // fallback to <name>.js
    || cleaner._test_file(cwd, name_js);
  cb(parsed);
};


cleaner._test_file = function (cwd, file) {
  var file = node_path.join(cwd, file);
  try {
    file = require.resolve(file);
  } catch(e) {
    return null;
  }
  return file;
};


cleaner.clean_pkg_entries = function (cwd, pkg, callback) {
  cleaner._clean_pkg_field(cwd, pkg, 'entries', callback);
};


cleaner.clean_pkg_css = function (cwd, pkg, callback) {
  cleaner._clean_pkg_field(cwd, pkg, 'css', callback);
};


// @param {string} key
cleaner._clean_pkg_field = function (cwd, pkg, key, callback) {
  var KEY = key.toUpperCase();
  cleaner._expand_items(cwd, pkg[key], function (err, files) {
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


cleaner._expand_items = function (cwd, value, callback) {
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
      cleaner._check_multi_exists(cwd, explicit_paths, function (not_found) {
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
cleaner._check_multi_exists = function (cwd, paths, callback) {
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
