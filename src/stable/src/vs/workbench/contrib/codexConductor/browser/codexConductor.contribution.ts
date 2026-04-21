/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frontier R&D Ltd. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { CodexConductorContribution } from './codexConductor.js';
import './codexPinManager.js';

registerWorkbenchContribution2(CodexConductorContribution.ID, CodexConductorContribution, WorkbenchPhase.AfterRestored);
