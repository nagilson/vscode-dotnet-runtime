/*---------------------------------------------------------------------------------------------
*  Licensed to the .NET Foundation under one or more agreements.
*  The .NET Foundation licenses this file to you under the MIT license.
*--------------------------------------------------------------------------------------------*/
import { IExtensionContext } from '../IExtensionContext';
import { sanitize } from './ContentSantizer';
import { IIssueContext } from './IIssueContext';
import * as fs from 'fs';
import * as os from 'os';

// tslint:disable no-var-requires
const packageJson = require('../../package.json');

const issuesUrl = `https://github.com/dotnet/vscode-dotnet-runtime/issues/new/choose`;

export function formatIssueUrl(error: Error | undefined, context: IIssueContext): [ string, string ] {
    context.logger.dispose(); // Ensure log file is up to date

    const errorMessage = !error ? '' : `**Error Message:** ${ sanitize(error!.message) }
**Error Stack:** ${ error.stack === undefined ? '' : sanitize(error!.stack!) }`;
    const issueBody = `<!-- IMPORTANT: Please be sure to remove any private information before submitting. -->

Please attach the log file located at ${ context.logger.getFileLocation() }. Note that this file may contain personal data.

**Extension Version:** ${ packageJson.version }
${ errorMessage }`;

const issueMessage = `
# Describe the bug



## **Please attach log file(s) here if you have any:**
>❗ Privacy Alert! The contents in our log files may contain personal data. Prior to posting to GitHub, please remove any personal data which should not be publicly viewable. https://privacy.microsoft.com/en-US/privacystatement

\`\`\`
${sanitize(fs.readFileSync(context.logger.getFileLocation(), 'utf8'))}
\`\`\`


## Other Info:
Errors the extension may have encountered have likely been added to your terminal or VS Code windows. Please paste it/them here and describe what happened and the problem you are facing.

**Reproduction Steps**


**Expected behavior**


**Exceptions & Errors (if any)**
${issueBody}

**Further technical details**
>❗
- Your VSCode Version:

- The version of the extension that's on your machine:

- Your operating system details: platform: ${os.platform()}, arch: ${os.arch()}
`;

    const url = `${issuesUrl}/new?body=${encodeURIComponent(issueMessage)}`;
    return [url, issueBody];
}
