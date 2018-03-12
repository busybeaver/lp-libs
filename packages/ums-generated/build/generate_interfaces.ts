/**
 * Automagically generate typings, interfaces, etc. for event data sent to and received from UMS.
 */

 /* tslint:disable: no-var-requires */

import { remove } from "fs-extra";
import * as Parser from "json-schema-ref-parser";
import { compile } from "json-schema-to-typescript";
import { query } from "jsonpath";
import { join, basename, extname } from "path";
import Ast from "ts-simple-ast";
import {
  SourceFile,
  Scope,
  VariableDeclarationType,
  EnumDeclarationStructure,
  EnumMemberStructure,
  PropertySignatureStructure,
  InterfaceDeclarationStructure,
  TypeAliasDeclarationStructure,
  FunctionDeclarationStructure,
  ClassDeclarationStructure,
  MethodDeclarationStructure,
  VariableStatementStructure,
  ExportDeclarationStructure,
  ImportDeclarationStructure,
  ImportSpecifierStructure,
} from "ts-simple-ast";

// we cannot use this modules via 'import' due to this (lets hope the modules get updated):
// https://github.com/Microsoft/TypeScript/issues/5073
const pascalCase = require("pascal-case");
const snakeCase = require("snake-case");

type schemaType = {
  url: string,
  fn?: (schema: any, sourceFile: SourceFile, fileName: string) => void,
};

const header = "/* tslint:disable */\n\n";
const autogeneratedBanner = "/** THIS FILE IS AUTOGENERATED FROM THE UMS JSON SCHEMA FILES. DO NOT EDIT MANUALLY. */";
const tsFileFormat = {
  ensureNewLineAtEndOfFile: true,
  indentSize: 2,
  convertTabsToSpaces: true,
};

const commonUmsFileName = "common_ums";
const notificationTypeName = "INotificationType";
const notificationTypesName = "INotificationsType";
const notificationHandlerName = "INotificationHandler";
const onNotificationFnName = "onNotification";
const sendMessageHandlerName = "ISendHandler";
const sendMessageFnName = "sendMessage";

const generateTypings = async ({url, fn}: schemaType): Promise<string> => {
  const ast = new Ast();
  const parser = new Parser();
  // https://github.com/BigstickCarpet/json-schema-ref-parser/blob/master/docs/ref-parser.md#bundleschema-options-callback
  // https://github.com/BigstickCarpet/json-schema-ref-parser/blob/master/docs/ref-parser.md#dereferenceschema-options-callback
  const schema = await parser.dereference(url);
  const name = basename(url, extname(url));
  const typings = await compile(schema, pascalCase(name), {enableConstEnums: true, bannerComment: ""});
  const fileName = snakeCase(name);
  const file = join(process.cwd(), "src", fileName + ".ts");
  await remove(file); // remove old/previous versions
  const sourceFile = ast.createSourceFile(file, typings);

  commonData(schema, sourceFile, name);
  if (typeof fn === "function") Reflect.apply(fn, null, [schema, sourceFile, fileName]);
  // await outputFile(join(process.cwd(), "src", filename), header + typings + eventTypesEnum + customContent);

  sourceFile.insertText(0, header + autogeneratedBanner + "\n\n");
  sourceFile.formatText(tsFileFormat);
  await sourceFile.save();

  return fileName;
};

const queryEvents = (schema: any): string[] => query(schema, "$.anyOf[*].title");
const queryEventName = (schema: any, event: string): string => query(schema, `$.anyOf[?(@.title == '${event}')].allOf[*].properties.type.default`)[0];

const commonData = (schema: any, sourceFile: SourceFile, baseName: string): void => {
  const events: string[] = queryEvents(schema);

  const mappings = events
    .map((event) => {
      const name = queryEventName(schema, event);
      return {event, name};
    });

  const capitalizedBaseName = pascalCase(baseName);
  const enumConfig: EnumDeclarationStructure = {
    name: `${capitalizedBaseName}Event`,
    isExported: true,
    isConst: true,
  };
  enumConfig.members = mappings.map(({event, name}): EnumMemberStructure => {
    return {
      // don't be confused with the naming (e.g. enum name != mapping name)
      name: event,
      value: name,
    };
  });
  sourceFile.addEnum(enumConfig);

  const interfaceConfig: InterfaceDeclarationStructure = {
    name: `I${capitalizedBaseName}Type`,
    isExported: true,
  };
  interfaceConfig.properties = mappings.map(({event, name}): PropertySignatureStructure => ({ name: `"${name}"`, type: pascalCase(event) }));
  sourceFile.addInterface(interfaceConfig);

  const typeConfig: TypeAliasDeclarationStructure = {
    name: `${capitalizedBaseName}Type`,
    type: mappings.map(({name}) => `"${name}"`).join(" | "),
    isExported: true,
  };
  sourceFile.addTypeAlias(typeConfig);

  const varConfig: VariableStatementStructure = {
    declarations: [{
      name: `${capitalizedBaseName}Events`,
      initializer: `[${events.map((event) => `"${event}"`).join(", ")}]`,
    }, {
      name: `${capitalizedBaseName}Types`,
      initializer: `[${mappings.map(({name}) => `"${name}"`).join(", ")}]`,
    }],
    declarationType: VariableDeclarationType.Const,
    isExported: true,
  };
  sourceFile.addVariableStatement(varConfig);
};

const customNotificationData = (baseName: string, schema: any, sourceFile: SourceFile): void => {
  const pascalName = `${pascalCase(baseName)}Notifications`;
  const events: string[] = queryEvents(schema);

  const commonImportConfig: ImportDeclarationStructure = {
    moduleSpecifier: `./${commonUmsFileName}`,
    namedImports: [{
      name: notificationTypesName,
    }, {
      name: notificationHandlerName,
    }],
  };
  sourceFile.addImport(commonImportConfig);

  const mappings = events
    .map((event) => {
      const name = queryEventName(schema, event);
      return {event, name};
    });

  const notifications = sourceFile.getTypeAliasOrThrow(pascalName);
  const notificationEvent = sourceFile.getEnumOrThrow(`${pascalName}Event`);
  const notificationType = sourceFile.getInterfaceOrThrow(`I${pascalName}Type`);
  notificationType.addExtends([`${notificationTypesName}<${sourceFile.getTypeAliasOrThrow(pascalName).getName()}>`]);

  const interfaceConfig: InterfaceDeclarationStructure = { name: `I${pascalName}Wrapper`, isExported: true };
  const typeConstraint = `${notificationHandlerName}<${notificationType.getName()}, ${notifications.getName()}>`;
  const typeConfig1: TypeAliasDeclarationStructure = {
    name: "Constructor",
    isExported: true,
    typeParameters: [{
      name: "T",
      constraint: typeConstraint,
    }],
    type: "new(...args: any[]) => T",
  };
  sourceFile.addTypeAlias(typeConfig1);
  const typeConfig2: TypeAliasDeclarationStructure = {
    name: `${pascalName}WrapperConstructor`,
    isExported: true,
    type: `new(...args: any[]) => ${interfaceConfig.name}`,
  };
  sourceFile.addTypeAlias(typeConfig2);

  const argsParamName = "args";
  const superClassName = "Base";
  const typeParamName = "T";
  const callbackName = "cb";
  const classConfig: ClassDeclarationStructure = {
    name: `${pascalName}Wrapper`,
    extends: superClassName,
    implements: [interfaceConfig.name],
    ctor: {
      parameters: [{
        name: argsParamName,
        isRestParameter: true,
      }],
      bodyText: `super(...${argsParamName});`,
    },
  };
  classConfig.methods = interfaceConfig.methods = events.map((event: string): MethodDeclarationStructure => {
    return {
      name: `on${pascalCase(event)}`,
      scope: Scope.Public,
      parameters: [{
        name: callbackName,
        type: `(notification: ${pascalCase(event)}) => void`,
      }],
      bodyText: `this.${onNotificationFnName}(${notificationEvent.getName()}.${notificationEvent.getMemberOrThrow(event).getName()}, ${callbackName});`,
      returnType: "void",
    };
  });
  sourceFile.addInterface(interfaceConfig);
  const functionConfig: FunctionDeclarationStructure = {
    name: `wrap${pascalName}`,
    typeParameters: [{
      name: typeParamName,
      constraint: `${typeConfig1.name}<${typeConstraint}>`,
    }],
    parameters: [{
      name: superClassName,
      type: typeParamName,
    }],
    returnType: `${typeParamName} & ${typeConfig2.name}`,
    isExported: true,
  };
  const fn = sourceFile.addFunction(functionConfig);
  fn.addClass(classConfig);
  fn.setBodyText(`${fn.getBodyOrThrow().getChildSyntaxListOrThrow().getFullText()}\nreturn ${classConfig.name};`);
};

const customConsumerNotificationData = (schema: any, sourceFile: SourceFile): void => customNotificationData("consumer", schema, sourceFile);
const customAgentNotificationData = (schema: any, sourceFile: SourceFile): void => customNotificationData("agent", schema, sourceFile);

const customConsumerResponseData = (schema: any, sourceFile: SourceFile, fileName: string): void => {
  // TODO: how to automatically check that we map all requests (e.g. in the case when new events occurr)
  const mapping: { [key: string]: string } = {
    InitConnection: "StringResp",
    UpdateConversationField: "StringResp",
    ConsumerRequestConversation: "RequestConversationResponse",
    PublishEvent: "PublishEventResponse",
    SubscribeMessagingEvents: "GenericSubscribeResponse",
    SubscribeExConversations: "SubscribeExConversationsResponse",
    UnsubscribeExConversations: "StringResp",
  };

  const pascalName = pascalCase(fileName);
  const prefix = fileName.split("_")[0];
  if (!prefix) throw new Error("Could not get/compute file prefix.");

  const requestFileName = `${prefix}_requests`;
  const requestImportConfig: ImportDeclarationStructure = {
    moduleSpecifier: `./${requestFileName}`,
  };
  const requestsEnumName = sourceFile.getEnumOrThrow(`${pascalName}Event`).getName().replace(pascalName, pascalCase(requestFileName));
  const requestsName = pascalCase(requestFileName);
  requestImportConfig.namedImports = Object.keys(mapping).map((req): ImportSpecifierStructure => ({ name: req }));
  requestImportConfig.namedImports.push({ name: requestsEnumName });
  requestImportConfig.namedImports.push({ name: requestsName });
  sourceFile.addImport(requestImportConfig);
  const typeImportConfig: ImportDeclarationStructure = {
    moduleSpecifier: "type-zoo",
    namedImports: [{
      name: "Omit",
    }],
  };
  sourceFile.addImport(typeImportConfig);
  const commonImportConfig: ImportDeclarationStructure = {
    moduleSpecifier: `./${commonUmsFileName}`,
    namedImports: [{
      name: sendMessageHandlerName,
    }],
  };
  sourceFile.addImport(commonImportConfig);

  const argsParamName = "args";
  const superClassName = "Base";
  const typeParamName = "T";
  const paramName = "data";

  const interfaceConfig: InterfaceDeclarationStructure = { name: `I${pascalName}Wrapper`, isExported: true };
  const classConfig: ClassDeclarationStructure = {
    name: `${pascalName}Wrapper`,
    extends: superClassName,
    implements: [interfaceConfig.name],
    ctor: {
      parameters: [{
        name: argsParamName,
        isRestParameter: true,
      }],
      bodyText: `super(...${argsParamName});`,
    },
  };
  classConfig.methods = interfaceConfig.methods = Object.entries(mapping).map(([req, res], a, b): MethodDeclarationStructure => {
    return {
      name: `do${pascalCase(req)}`,
      scope: Scope.Public,
      parameters: [{
        name: paramName,
        type: `Omit<${req}, "type">`, // TODO: not working as expected right now :/
      }],
      bodyText: `return this.${sendMessageFnName}(Object.assign(${paramName}, { type: ${requestsEnumName}.${req} }) as ${req});`,
      returnType: `Promise<${res}>`,
    };
  });
  sourceFile.addInterface(interfaceConfig);

  const typeConstraint = `${sendMessageHandlerName}<${requestsName}, ${pascalName}>`;
  const typeConfig1: TypeAliasDeclarationStructure = {
    name: "Constructor",
    isExported: true,
    typeParameters: [{
      name: typeParamName,
      constraint: typeConstraint,
    }],
    type: `new(...args: any[]) => ${typeParamName}`,
  };
  sourceFile.addTypeAlias(typeConfig1);
  const typeConfig2: TypeAliasDeclarationStructure = {
    name: `${pascalName}WrapperConstructor`,
    isExported: true,
    type: `new(...args: any[]) => ${interfaceConfig.name}`,
  };
  sourceFile.addTypeAlias(typeConfig2);

  const functionConfig: FunctionDeclarationStructure = {
    name: `wrap${pascalName}`,
    typeParameters: [{
      name: typeParamName,
      constraint: `${typeConfig1.name}<${typeConstraint}>`,
    }],
    parameters: [{
      name: superClassName,
      type: typeParamName,
    }],
    returnType: `${typeParamName} & ${typeConfig2.name}`,
    isExported: true,
  };
  const fn = sourceFile.addFunction(functionConfig);
  fn.addClass(classConfig);
  fn.setBodyText(`${fn.getBodyOrThrow().getChildSyntaxListOrThrow().getFullText()}\nreturn ${classConfig.name};`);
};

const generateGenericTypings = async (): Promise<string> => {
  const ast = new Ast();
  const file = join(process.cwd(), "src", `${commonUmsFileName}.ts`);
  await remove(file); // remove old/previous versions
  const sourceFile = ast.createSourceFile(file);

  const typedName = "ITyped";
  const typedInterfaceConfig: InterfaceDeclarationStructure = {
    name: typedName,
    isExported: true,
    properties: [{
      name: "type",
      type: "string",
    }],
  };
  sourceFile.addInterface(typedInterfaceConfig);

  const sendInterfaceConfig: InterfaceDeclarationStructure = {
    name: "ISendType",
    isExported: true,
    extends: [typedName],
    properties: [{
      name: "id",
      type: "string",
    }],
  };
  sourceFile.addInterface(sendInterfaceConfig);

  const responseInterfaceConfig: InterfaceDeclarationStructure = {
    name: "IResponseType",
    isExported: true,
    extends: [typedName],
    properties: [{
      name: "reqId",
      type: "string",
    }],
  };
  sourceFile.addInterface(responseInterfaceConfig);

  const notificationInterfaceConfig: InterfaceDeclarationStructure = {
    name: notificationTypeName,
    isExported: true,
    extends: [typedName],
  };
  sourceFile.addInterface(notificationInterfaceConfig);

  const notificationTypesParamName = "NotificationType";
  const notificationTypesConfig: TypeAliasDeclarationStructure = {
    name: notificationTypesName,
    isExported: true,
    typeParameters: [{
      name: notificationTypesParamName,
      constraint: notificationInterfaceConfig.name,
    }],
    type: `{ [key: string]: ${notificationTypesParamName} }`,
  };
  sourceFile.addTypeAlias(notificationTypesConfig);

  const notificationTypeKeyName = "K";
  const notificationType = "NotificationType";
  const notificationTypes = "NotificationTypes";
  const notificationHandlerFn: MethodDeclarationStructure = {
    name: onNotificationFnName,
    parameters: [{
      name: "notificationType",
      type: notificationTypeKeyName,
    }, {
      name: "cb",
      type: `(notification: ${notificationTypes}[${notificationTypeKeyName}]) => void`,
    }],
    typeParameters: [{
      name: notificationTypeKeyName,
      constraint: `keyof ${notificationTypes}`,
    }],
    returnType: "void",
  };
  const notificationHandlerInterfaceConfig: InterfaceDeclarationStructure = {
    name: notificationHandlerName,
    isExported: true,
    typeParameters: [{
      name: notificationTypes,
      constraint: `${notificationTypesName}<${notificationType}>`,
    }, {
      name: notificationType,
      constraint: notificationTypeName,
    }],
    methods: [notificationHandlerFn],
  };
  sourceFile.addInterface(notificationHandlerInterfaceConfig);

  const sendTypeName = "SendType";
  const responseTypeName = "ResponseType";
  const sendMessageFn: MethodDeclarationStructure = {
    name: sendMessageFnName,
    parameters: [{
      name: "req",
      type: sendTypeName,
    }],
    returnType: `Promise<${responseTypeName}>`,
  };
  const sendMessageInterfaceConfig: InterfaceDeclarationStructure = {
    name: sendMessageHandlerName,
    isExported: true,
    typeParameters: [{
      name: sendTypeName,
      constraint: sendInterfaceConfig.name,
    }, {
      name: responseTypeName,
      constraint: responseInterfaceConfig.name,
    }],
    methods: [sendMessageFn],
  };
  sourceFile.addInterface(sendMessageInterfaceConfig);

  sourceFile.insertText(0, header + autogeneratedBanner + "\n\n");
  sourceFile.formatText(tsFileFormat);
  await sourceFile.save();

  return commonUmsFileName;
};

const jsonSchemaUrls: schemaType[] = [
  // ordering is importent, requests need to be done before responses
  {url: "https://developers.liveperson.com/assets/schema/ws/consumerRequests.json"},
  {url: "https://developers.liveperson.com/assets/schema/ws/consumerResponses.json", fn: customConsumerResponseData},
  {url: "https://developers.liveperson.com/assets/schema/ws/consumerNotifications.json", fn: customConsumerNotificationData},
  // TODO: not working yet due to invalid JSON schema: {url: "https://developers.liveperson.com/assets/schema/ws/agentRequests.json"},
  {url: "https://developers.liveperson.com/assets/schema/ws/agentResponses.json"},
  {url: "https://developers.liveperson.com/assets/schema/ws/agentNotifications.json", fn: customAgentNotificationData},
  // {url: https://developers.liveperson.com/assets/schema/infra/stringResp.json}, // part of "consumerResponses.json" and "agentResponses.json",
];

(async () => {
  try {
    const tsFiles = await Promise.all(jsonSchemaUrls.map(generateTypings));
    tsFiles.push(await generateGenericTypings());

    const ast = new Ast();
    const file = join(process.cwd(), "src", "index.ts");
    await remove(file); // remove old/previous versions
    const sourceFile = ast.createSourceFile(file);

    tsFiles.map((tsFile) => {
      // sourceFile.addStatements("// @ts-ignore");
      const exportStatement = sourceFile.addExport({ moduleSpecifier: `./${tsFile}` });
      // https://github.com/dsherret/ts-simple-ast/issues/189
      sourceFile.insertStatements(exportStatement.getChildIndex(), "// @ts-ignore");
    });

    sourceFile.insertText(0, header + autogeneratedBanner + "\n\n");
    sourceFile.formatText(tsFileFormat);
    await sourceFile.save();
  } catch (err) {
    // tslint:disable-next-line: no-console
    console.log("Failed to create typings file", err);
    return err;
  }
})();
