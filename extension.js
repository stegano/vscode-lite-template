// Import the module and reference it with the alias vscode in your code below
const vscode = require("vscode");
const path = require("path");
const fs = require("fs-extra");
const changeCase = require("change-case");

function getWorkingPathDir(context, activeTextEditor, workspace) {
  if (context) {
    const { fsPath } = context;
    const stats = fs.statSync(context.fsPath);
    return stats.isDirectory() ? fsPath : path.dirname(fsPath);
  } else if (activeTextEditor) {
    return path.dirname(activeTextEditor.document.fileName);
  } else {
    return workspace.rootPath;
  }
}

async function findVariablePatterns(filePath) {
  const stat = await fs.stat(filePath);
  const ret = [];
  if(stat.isDirectory()) {
    const files = await fs.readdir(filePath);
    const results = (await Promise.all(
      files.map(async entryFilePath => {
        return findVariablePatterns(
          path.resolve(filePath, entryFilePath),
        )
      })
    )).reduce((ret, result) => {
      ret.push.apply(ret, result);
      return ret;
    }, []);
    ret.push.apply(ret, results)
  } else {
    const fileText = (await fs.readFile(filePath)).toString("utf8");
    const matchPattern = /\$\$var_[a-zA-Z0-9]+/g;
    const variableInFilepath = filePath.match(matchPattern);
    variableInFilepath 
      && variableInFilepath.forEach((variable) => {
        const [, value] = variable.split('_');
        ret.push(value);
      });
    const variablesInFileText = fileText.match(matchPattern);
    variablesInFileText 
      && variablesInFileText.forEach((variable) => {
        const [, value] = variable.split('_');
        ret.push(value);
      });
  }
  return ret;
}

async function replaceTextInFiles(
  filePath,
  templateName,
  replaceFileTextFn,
  renameFileFn,
  renameSubDirectoriesFn
) {
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      const files = await fs.readdir(filePath);
      await Promise.all(
        files.map(async entryFilePath => {
          return replaceTextInFiles(
            path.resolve(filePath, entryFilePath),
            templateName,
            replaceFileTextFn,
            renameFileFn,
            renameSubDirectoriesFn
          )
        })
      );
      if (typeof renameSubDirectoriesFn === 'function') {
        const currDirectoryName = path.basename(filePath);
        const newDirectoryName = renameSubDirectoriesFn(currDirectoryName, templateName, {
          changeCase,
          path
        });
        const newPath = path.resolve(filePath, '../', newDirectoryName);
        fs.renameSync(filePath, newPath);
      }
    } else {
      const fileText = (await fs.readFile(filePath)).toString("utf8");
      if (typeof replaceFileTextFn === "function") {
        await fs.writeFile(
          filePath,
          replaceFileTextFn(fileText, templateName, { changeCase, path })
        );
        /**
         * Rename file
         * @ref https://github.com/stegano/vscode-template/issues/4
         */
        if (typeof renameFileFn === "function") {
          const filePathInfo = path.parse(filePath);
          const { base: originalFilename } = filePathInfo;
          const filename = renameFileFn(originalFilename, templateName, {
            changeCase,
            path
          });
          const _filePath = path.resolve(filePathInfo.dir, filename);
          filename && fs.renameSync(filePath, _filePath);
        }
      }
    }
  } catch (e) {
    console.error(e);
  }
}

// Make a default configuration file
async function makeTemplateConfigJs(configFilePath) {
  const defaultConfigFile = (
    await fs.readFile(path.resolve(__dirname, "./assets", "template.config.js"))
  ).toString("utf8");
  await fs.writeFile(configFilePath, defaultConfigFile);
}

// Make a `.templates` folder in workspace and make sample templates in `.templates` folder
async function makeSampleTemplate(templateRootPath) {
  const defaultSampleTemplatesPath = path.resolve(
    __dirname,
    "./assets/.templates"
  );

  // Make template path and subfolders
  await fs.mkdirs(templateRootPath);
  await fs.copy(defaultSampleTemplatesPath, templateRootPath);
}

async function createNew(_context, isRenameTemplate) {
  try {
    const workspaceRootPath = vscode.workspace.rootPath;
    const configFilePath = path.resolve(
      workspaceRootPath,
      "template.config.js"
    );

    // If not exist configuration file, make a default configuration file at workspace.
    if (!(await fs.pathExists(configFilePath))) {
      await makeTemplateConfigJs(configFilePath);
    }

    /**
     * Clear the `template.config.js` cache from `require`
     */
    delete require.cache[configFilePath];
    const config = require(configFilePath);
    const templateRootPath = path.resolve(
      workspaceRootPath,
      config.templateRootPath || config.templatePath // deprecated `config.templatePath`
    );

    // If not exist `config.templateRootPath`, make `.templates` folder and make sample templates in `.templates`
    if (!(await fs.pathExists(templateRootPath))) {
      await makeSampleTemplate(templateRootPath);
    }

    const workingPathDir = getWorkingPathDir(
      _context,
      vscode.window.activeTextEditor,
      vscode.workspace
    );

    const templatePaths = await fs.readdir(templateRootPath);

    const templateName = await vscode.window.showQuickPick(templatePaths, {
      placeHolder: "Choose a template"
    });

    // If no input data, do nothing
    if (templateName === undefined) {
      return;
    }

    // Copy a template to path
    const srcPath = path.resolve(templateRootPath, templateName);

    // Input template name from user
    const dstTemplateName = isRenameTemplate
      ? await vscode.window.showInputBox({
        prompt: "Input a template name",
        value: templateName
      })
      : templateName;

    const dstPath = path.resolve(workingPathDir, dstTemplateName);

    /**
     * Variables found in file or filename
     * @ref https://github.com/stegano/vscode-template/issues/20
     */
    const variables = [...new Set(await findVariablePatterns(srcPath))];

    const COMMAND_SKIP = 'Skip...';
    const replaceValues = {};

    while(variables.length > 0){
      try {
        /**
         * Selected variableName
         */
        const selectedVariableName = await vscode.window.showQuickPick([
          ...variables,
          COMMAND_SKIP,
        ], {
          placeHolder: "To change the value of a variable, select the variable name."
        });

        if(selectedVariableName === COMMAND_SKIP) {
          break;;
        }
  
        /**
         * Input value by user
         */
        const selectedVariableValue = await vscode.window.showInputBox({
          prompt: `Input a ${selectedVariableName} value`,
          value: ''
        });

        replaceValues[selectedVariableName] = selectedVariableValue;
        variables.splice(variables.indexOf(selectedVariableName), 1);
      }catch(e) {
        break;
      }
    }

    // Write template files to destination path
    await fs.copy(srcPath, dstPath);
    
    await replaceTextInFiles(
      dstPath,
      dstTemplateName,
      config.replaceFileTextFn,
      /**
       * @deprecated `replaceFileNameFn` is deprecated, using `renameFileFn`
       */
      config.renameFileFn || config.replaceFileNameFn,
      config.renameSubDirectoriesFn
    );

    const replaceTextWithVariables = (target) => {
      /**
       * The `target` can be fileText or filename or directoryName
       */
      const res = Object.keys(replaceValues).reduce((ret, name) => {
        return ret.replace(RegExp(`\\$\\$var_${name}`, 'g'), replaceValues[name])
      }, target)

      /**
       *  `$$changeCase_pascalCase(...)` and other methods support
       */
      return res.replace(/\$\$changeCase_([^(]+)\(([^)]+)\)/g,
        (match, p1, p2) => {
          if (match) {
            const caseKey = p1
            if (caseKey) {
              return changeCase[caseKey](p2)
            }
          }
        }
      )
    }
    /**
     * In order to reduce the complexity of the source code during maintenance, 
     * the source code is separated and executed.
     */
    await replaceTextInFiles(
      dstPath,
      dstTemplateName,
      replaceTextWithVariables,
      replaceTextWithVariables,
      replaceTextWithVariables
    )
    vscode.window.showInformationMessage("Template: copied!");
  } catch (e) {
    console.error(e.stack);
    vscode.window.showErrorMessage(e.message);
  }
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  // This line of code will only be executed once when your extension is activated
  // The command has been defined in the package.json file
  // Now provide the implementation of the command with  registerCommand
  // The commandId parameter must match the command field in package.json
  context.subscriptions.push(
    vscode.commands.registerCommand("extension.createNew", context =>
      createNew(context, false)
    ),
    vscode.commands.registerCommand("extension.createNewWithRename", context =>
      createNew(context, true)
    )
  );
}


// this method is called when your extension is deactivated
function deactivate() { }

module.exports = {
  activate,
  deactivate
};
