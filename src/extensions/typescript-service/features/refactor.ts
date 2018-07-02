/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import {CancellationToken, CodeAction, CodeActionContext, CodeActionKind, Range, TextDocument} from 'vscode-languageserver-protocol'
import commandManager, {Command} from '../../../commands'
import {CodeActionProvider, CodeActionProviderMetadata} from '../../../provider'
import {showQuickpick} from '../../../util'
import workspace from '../../../workspace'
import * as Proto from '../protocol'
import {ITypeScriptServiceClient} from '../typescriptService'
import * as typeConverters from '../utils/typeConverters'
import FormattingOptionsManager from './fileConfigurationManager';
import touch = require('touch')
const logger = require('../../../util/logger')('typescript-langauge-refactor')

class ApplyRefactoringCommand implements Command {
  public static readonly ID = '_typescript.applyRefactoring'
  public readonly id = ApplyRefactoringCommand.ID

  constructor(private readonly client: ITypeScriptServiceClient) {}

  public async execute(
    document: TextDocument,
    file: string,
    refactor: string,
    action: string,
    range: Range
  ): Promise<boolean> {
    const args: Proto.GetEditsForRefactorRequestArgs = {
      ...typeConverters.Range.toFileRangeRequestArgs(file, range),
      refactor,
      action
    }
    const response = await this.client.execute('getEditsForRefactor', args)
    const body = response && response.body
    if (!body || !body.edits.length) {
      return false
    }

    const workspaceEdit = await this.toWorkspaceEdit(body)
    if (!(await workspace.applyEdit(workspaceEdit))) {
      return false
    }

    const renameLocation = body.renameLocation
    if (renameLocation) {
      logger.debug('renameLocation:', renameLocation)
      await commandManager.executeCommand('editor.action.rename', [
        document.uri,
        typeConverters.Position.fromLocation(renameLocation)
      ])
    }
    return true
  }

  private async toWorkspaceEdit(body: Proto.RefactorEditInfo) {
    for (const edit of body.edits) {
      touch.sync(edit.fileName)
    }
    let workspaceEdit = typeConverters.WorkspaceEdit.fromFileCodeEdits(
      this.client,
      body.edits
    )
    return workspaceEdit
  }
}

class SelectRefactorCommand implements Command {
  public static readonly ID = '_typescript.selectRefactoring'
  public readonly id = SelectRefactorCommand.ID

  constructor(private readonly doRefactoring: ApplyRefactoringCommand) {}

  public async execute(
    document: TextDocument,
    file: string,
    info: Proto.ApplicableRefactorInfo,
    range: Range
  ): Promise<boolean> {
    const selected = await showQuickpick(workspace.nvim,
      info.actions.map(action => action.name)
    )
    if (selected == -1) return false
    let label = info.actions[selected].name
    if (!label) return false
    return this.doRefactoring.execute(
      document,
      file,
      info.name,
      label,
      range
    )
  }
}

export default class TypeScriptRefactorProvider implements CodeActionProvider {
  private static readonly extractFunctionKind = CodeActionKind.RefactorExtract + '.function'
  private static readonly extractConstantKind = CodeActionKind.RefactorExtract + '.constant'
  private static readonly moveKind = CodeActionKind.Refactor + '.move'

  constructor(
    private readonly client: ITypeScriptServiceClient,
    private readonly formattingOptionsManager: FormattingOptionsManager,
  ) {
    const doRefactoringCommand = commandManager.register(
      new ApplyRefactoringCommand(this.client)
    )
    commandManager.register(new SelectRefactorCommand(doRefactoringCommand))
  }

  public static readonly metadata: CodeActionProviderMetadata = {
    providedCodeActionKinds: [CodeActionKind.Refactor]
  }

  public async provideCodeActions(
    document: TextDocument,
    range: Range,
    context: CodeActionContext,
    token: CancellationToken
  ): Promise<CodeAction[] | undefined> {
    if (!this.shouldTrigger(context)) {
      return undefined
    }
    const file = this.client.toPath(document.uri)
    if (!file) return undefined
    await this.formattingOptionsManager.ensureConfigurationForDocument(document);
    const args: Proto.GetApplicableRefactorsRequestArgs = typeConverters.Range.toFileRangeRequestArgs(
      file,
      range
    )
    logger.debug(args)
    let response: Proto.GetApplicableRefactorsResponse
    try {
      response = await this.client.execute('getApplicableRefactors', args, token)
      logger.debug(response)
      if (!response || !response.body) {
        return undefined
      }
    } catch {
      return undefined
    }

    return this.convertApplicableRefactors(
      response.body,
      document,
      file,
      range
    )
  }

  private convertApplicableRefactors(
    body: Proto.ApplicableRefactorInfo[],
    document: TextDocument,
    file: string,
    rangeOrSelection: Range
  ) {
    const actions: CodeAction[] = []
    for (const info of body) {
      if (info.inlineable === false) {
        const codeAction:CodeAction = {
          title: info.description,
          kind: CodeActionKind.Refactor
        }
        codeAction.command = {
          title: info.description,
          command: SelectRefactorCommand.ID,
          arguments: [document, file, info, rangeOrSelection]
        }
        actions.push(codeAction)
      } else {
        for (const action of info.actions) {
          actions.push(
            this.refactorActionToCodeAction(
              action,
              document,
              file,
              info,
              rangeOrSelection
            )
          )
        }
      }
    }
    return actions
  }

  private refactorActionToCodeAction(
    action: Proto.RefactorActionInfo,
    document: TextDocument,
    file: string,
    info: Proto.ApplicableRefactorInfo,
    rangeOrSelection: Range
  ) {
    const codeAction:CodeAction = {
      title: action.description,
      kind: TypeScriptRefactorProvider.getKind(action)
    }
    codeAction.command = {
      title: action.description,
      command: ApplyRefactoringCommand.ID,
      arguments: [document, file, info.name, action.name, rangeOrSelection]
    }
    return codeAction
  }

  private shouldTrigger(context: CodeActionContext) {
    if (
      context.only &&
      context.only.indexOf(CodeActionKind.Refactor) == -1
    ) {
      return false
    }
    return true
  }

  private static getKind(refactor: Proto.RefactorActionInfo) {
    if (refactor.name.startsWith('function_')) {
      return TypeScriptRefactorProvider.extractFunctionKind
    } else if (refactor.name.startsWith('constant_')) {
      return TypeScriptRefactorProvider.extractConstantKind
    } else if (refactor.name.startsWith('Move')) {
      return TypeScriptRefactorProvider.moveKind
    }
    return CodeActionKind.Refactor
  }
}
