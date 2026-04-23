/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frontier R&D Ltd. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { CodexSideloaderContribution } from './codexSideloader.js';

registerWorkbenchContribution2(CodexSideloaderContribution.ID, CodexSideloaderContribution, WorkbenchPhase.AfterRestored);
