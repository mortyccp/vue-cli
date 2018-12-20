module.exports = function lint(args = {}, api, silent) {
  const cwd = api.resolve(".");
  const fs = require("fs");
  const path = require("path");
  const globby = require("globby");
  const tslint = require("tslint");
  const ts = require("typescript");
  /* eslint-disable-next-line node/no-extraneous-require */
  const vueCompiler = require("vue-template-compiler");
  const isVueFile = file => /\.vue(\.ts)?$/.test(file);

  const options = {
    fix: args["fix"] !== false,
    formatter: args.format || "codeFrame",
    formattersDirectory: args["formatters-dir"],
    rulesDirectory: args["rules-dir"]
  };

  // hack to make tslint --fix work for *.vue files:
  // we save the non-script parts to a cache right before
  // linting the file, and patch fs.writeFileSync to combine the fixed script
  // back with the non-script parts.
  // this works because (luckily) tslint lints synchronously.
  const vueFileCache = new Map();
  const writeFileSync = fs.writeFileSync;

  const patchWriteFile = () => {
    fs.writeFileSync = (file, content, options) => {
      if (isVueFile(file)) {
        const parts = vueFileCache.get(path.normalize(file));
        if (parts) {
          const { before, after } = parts;
          content = `${before}\n${content.trim()}\n${after}`;
        }
      }
      return writeFileSync(file, content, options);
    };
  };

  const restoreWriteFile = () => {
    fs.writeFileSync = writeFileSync;
  };

  const parseTSFromVueFile = file => {
    const content = fs.readFileSync(file, "utf-8");
    const { script } = vueCompiler.parseComponent(content, { pad: "line" });
    if (script && /^tsx?$/.test(script.lang)) {
      vueFileCache.set(file, {
        before: content.slice(0, script.start),
        after: content.slice(script.end)
      });
      return script.content;
    }
  };

  const parseTSConfig = configFile => {
    const extraExtensions = ["vue"];
    const parseConfigHost = {
      fileExists: ts.sys.fileExists,
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      readFile: file => {
        return fs.readFileSync(file, "utf8");
      },
      readDirectory: (rootDir, extensions, excludes, includes, depth) => {
        return ts.sys.readDirectory(
          rootDir,
          extensions.concat(extraExtensions),
          excludes,
          includes,
          depth
        );
      }
    };
    const tsconfig = ts.readConfigFile(configFile, ts.sys.readFile).config;
    const parsed = ts.parseJsonConfigFileContent(
      tsconfig,
      parseConfigHost,
      path.dirname(configFile)
    );
    parsed.options.allowNonTsExtensions = true;
    parsed.options.noEmit = true;
    return parsed;
  };
  const tsconfigPath = api.resolve("tsconfig.json");
  const parsedTSConfig = parseTSConfig(tsconfigPath);

  function resolveNonTsModuleName(
    moduleName,
    containingFile,
    basedir,
    options
  ) {
    const baseUrl = options.baseUrl ? options.baseUrl : basedir;
    const discardedSymbols = [".", "..", "/"];
    const wildcards = [];
    if (options.paths) {
      Object.keys(options.paths).forEach(key => {
        const pathSymbol = key[0];
        if (
          discardedSymbols.indexOf(pathSymbol) < 0 &&
          wildcards.indexOf(pathSymbol) < 0
        ) {
          wildcards.push(pathSymbol);
        }
      });
    } else {
      wildcards.push("@");
    }
    const isRelative = !path.isAbsolute(moduleName);
    let correctWildcard;
    wildcards.forEach(wildcard => {
      if (moduleName.substr(0, 2) === `${wildcard}/`) {
        correctWildcard = wildcard;
      }
    });
    if (correctWildcard) {
      const pattern = options.paths
        ? options.paths[`${correctWildcard}/*`]
        : undefined;
      const substitution = pattern
        ? options.paths[`${correctWildcard}/*`][0].replace("*", "")
        : "src";
      moduleName = path.resolve(baseUrl, substitution, moduleName.substr(2));
    } else if (isRelative) {
      moduleName = path.resolve(path.dirname(containingFile), moduleName);
    }
    return moduleName;
  }

  const createTSProgram = parsedTSConfig => {
    const host = ts.createCompilerHost(parsedTSConfig.options);
    const realGetSourceFile = host.getSourceFile;
    // We need a host that can parse Vue SFCs (single file components).
    host.getSourceFile = function(filePath, languageVersion, onError) {
      let source = realGetSourceFile(filePath, languageVersion, onError);
      if (isVueFile(filePath)) {
        const script = parseTSFromVueFile(filePath) || "";
        source = ts.createSourceFile(filePath, script, languageVersion, true);
      }
      return source;
    };
    return ts.createProgram(
      parsedTSConfig.fileNames,
      parsedTSConfig.options,
      host
    );
  };
  const tsProgram = createTSProgram(parsedTSConfig);

  const linter = new tslint.Linter(options, tsProgram);

  const tslintConfigPath = api.resolve("tslint.json");

  const config = tslint.Configuration.findConfiguration(tslintConfigPath)
    .results;
  // create a patched config that disables the blank lines rule,
  // so that we get correct line numbers in error reports for *.vue files.
  const vueConfig = Object.assign(config);
  const rules = (vueConfig.rules = new Map(vueConfig.rules));
  const rule = rules.get("no-consecutive-blank-lines");
  rules.set(
    "no-consecutive-blank-lines",
    Object.assign({}, rule, {
      ruleSeverity: "off"
    })
  );

  const lint = file => {
    const filePath = api.resolve(file);
    const isVue = isVueFile(file);
    patchWriteFile();
    linter.lint(
      // append .ts so that tslint apply TS rules
      filePath,
      "",
      // use Vue config to ignore blank lines
      isVue ? vueConfig : config
    );
    restoreWriteFile();
  };

  const files =
    args._ && args._.length
      ? args._
      : [
          "src/**/*.ts",
          "src/**/*.vue",
          "src/**/*.tsx",
          "tests/**/*.ts",
          "tests/**/*.tsx"
        ];

  // respect linterOptions.exclude from tslint.json
  if (config.linterOptions && config.linterOptions.exclude) {
    // use the raw tslint.json data because config contains absolute paths
    const rawTslintConfig = JSON.parse(
      fs.readFileSync(tslintConfigPath, "utf-8")
    );
    const excludedGlobs = rawTslintConfig.linterOptions.exclude;
    excludedGlobs.forEach(g => files.push("!" + g));
  }

  return globby(files, { cwd }).then(files => {
    for (const sourceFile of tsProgram.getSourceFiles()) {
      tsProgram.getSemanticDiagnostics(sourceFile);
    }

    files.forEach(lint);
    if (silent) return;
    const result = linter.getResult();
    if (result.output.trim()) {
      process.stdout.write(result.output);
    } else if (result.fixes.length) {
      // some formatters do not report fixes.
      const f = new tslint.Formatters.ProseFormatter();
      process.stdout.write(f.format(result.failures, result.fixes));
    } else if (!result.failures.length) {
      console.log(`No lint errors found.\n`);
    }

    if (result.failures.length && !args.force) {
      process.exitCode = 1;
    }
  });
};
