'use strict';
const Promise = require('bluebird');
const ts = require('typescript');
const fs = require('fs');
const path = require('path');
const glob = require('glob');
const _ = require('lodash')

let once = true

function resolveDecorators(fileNames, options) {
  // Build a program using the set of root file names in fileNames
  let program = ts.createProgram(fileNames, options);

  // Get the checker, we will use it to find more about classes
  let checker = program.getTypeChecker();

  let decorators = [];

  // Visit every sourceFile in the program
  for (const sourceFile of program.getSourceFiles()) {
    // Walk the tree to search for classes
    ts.forEachChild(sourceFile, (node) => visit(node, sourceFile.fileName));
  }

  return decorators

  /** visit nodes finding exported classes */
  function visit(node, fileName) {
    if (node.kind === ts.SyntaxKind.ClassDeclaration) {
      // This is a top level class, get its symbol
      if (node.decorators) {
        decorators = [
          ...decorators,
          ...node.decorators.map(s => serializeDecorator(node, s, fileName))
        ]

      }
    } else if (node.kind === ts.SyntaxKind.ModuleDeclaration) {
      // This is a namespace, visit its children
      ts.forEachChild(node, (s) => visit(s, fileName));
    }
  }

  function serializeSymbol(symbol) {
    return {
      name: symbol.getName(),
      documentation: ts.displayPartsToString(symbol.getDocumentationComment()),
      type: checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration))
    };
  }

  /** Serialize a signature (call or construct) */
  function serializeSignature(signature) {
    return {
      parameters: signature.parameters.map(serializeSymbol),
      returnType: checker.typeToString(signature.getReturnType()),
      documentation: ts.displayPartsToString(signature.getDocumentationComment())
    };
  }

  function serializeDecorator(node, decorator, fileName) {
    let symbol = checker.getSymbolAtLocation(decorator.expression.getFirstToken());
    let decoratorType = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration);
    let details = serializeSymbol(symbol);
    details.parameters = []
    details.constructors = decoratorType.getCallSignatures().map(serializeSignature);
    let parseParameters = (t) => {
      ts.forEachChild(t, (x) => {
        if (x.kind === ts.SyntaxKind.PropertyAssignment) {
          let result = {}
          result.name = x.name.text
          ts.forEachChild(x, (y) => {
            if (y.kind === ts.SyntaxKind.NumericLiteral) {
              result.value = parseInt(y.text)
            } else /*if(y.kind === ts.SyntaxKind.StringLiteral)*/ {
              result.value = y.text
            }
          })
          if (result.value) {
            details.parameters.push(result)
          }
        }
      })
    }
    let foundParamter = false
    let findParamter = (t) => {
      if (t.kind === ts.SyntaxKind.CallExpression) {
        foundParamter = true
        ts.forEachChild(t, parseParameters)
      } else if (!foundParamter) {
        ts.forEachChild(t, findParamter)
      }
    }
    ts.forEachChild(node, findParamter)

    ts.forEachChild(node, (node) => {
      if (node.decorators) {
        details.childDecorators = node.decorators.map(s => serializeDecorator(node, s, fileName))
      }
    });

    details.fileName = fileName;
    return details;
  }
}

const ROOT_PATH = path.join(__dirname, '..', '..', 'src')

class ServerlessAnnotations {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;


    this.commands = {
      'collect': {
        usage: 'Collects all lambda entry modules',
        lifecycleEvents: [
          'init'
        ]
      }
    };

    this.hooks = {
      'before:package:initialize': () => this.collectLambda(),
      'before:invoke:invoke': () => this.collectLambda(),
      'before:deploy:function:initialize' : () => this.collectLambda(),
      'collect:init': () => this.collectLambda(),
    };

  }

  collectLambda() {
    return new Promise((resolve, reject) => {
      let config = _.assign({}, {
        pattern: '**/*.ts',
        ignore: ['src/shared'],
        handlers: {
          handler: {}
        }
      }, this.serverless.service.custom.annotations);

      const files = glob.sync(config.pattern, {
        ignore: config.ignore,
        // root: ROOT_PATH
      })
      let decorators = resolveDecorators(files, {
        target: ts.ScriptTarget.ES5,
        module: ts.ModuleKind.CommonJS
      });

      let handlers = decorators
        .filter(d => Object.keys(config.handlers).indexOf(d.name) >= 0)
        .map(d => ({
          name: d.name,
          options: _.mapValues(_.keyBy(d.parameters, 'name'), 'value'),
          fileName: d.fileName.replace(ROOT_PATH + '/', ''),
          handlers: d.childDecorators ? d.childDecorators.map(c => ({
            name: c.name,
            options: _.mapValues(_.keyBy(c.parameters, 'name'), 'value')
          })) : undefined
        }));

      this.serverless.service.functions = this.serverless.service.functions || {}
      let stage = this.serverless.service.provider.stage;
      if (this.serverless.variables.options.stage) {
        stage = this.serverless.variables.options.stage;
      }
      for (let handler of handlers) {
        if (!handler.options) {
          throw new Error('Could not get handler options')
        }
        if (!handler.options.name) {
          throw new Error('Hanlder name has to be provided')
        }
        if (this.serverless.service.functions[handler.options.name]) {
          throw new Error(`Handler with name ${handler.options.name} already exists`)
        }
        this.serverless.service.functions[handler.options.name] = Object.assign({}, {
          handler: handler.fileName.replace(/.ts$/, '.default'),
          name: `${this.serverless.service.service}-${stage}-${handler.options.name}`
        }, config.handlers[handler.name], _.omit(handler.options, 'name'))
      }
      console.log(JSON.stringify(this.serverless.service.functions))
      resolve()

      // reject()
    })
  }




}

module.exports = ServerlessAnnotations;