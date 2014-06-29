'use strict';


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


exports._clean_pkg_css = function (cwd, pkg, callback) {
  var css = pkg.css;
  if (!css) {
    // #8
    // standardize `pkg.css` and make sure it is always an array.
    pkg.css = [];
    return callback(null, pkg);
  }

  css = util.isArray(css)
    ? css
    : [css];

  expand(css, {
    cwd: cwd,
    globOnly: true

  }, function (err, files) {
    if (err) {
      return callback(err);
    }

    if (css.length && !files.length) {
      return callback({
        code: 'INVALID_CORTEX_CSS',
        message: '`cortex.css` defined but no css files found.',
        data: {
          css: css
        }
      });
    }

    pkg.css = files;
    callback(null, pkg);
  });
};


exports._clean_pkg_main = function (cwd, pkg, callback) {
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
        message: '`cortex.main` is defined but "' + main + '" not found.',
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
