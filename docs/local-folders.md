# Local folders in the browser

In Chromium browsers, typstry can keep a project in sync with a folder on your computer. You write in the browser or in your own editor, and both see the changes within a few seconds. The project still lives on the server, so sharing, history and collaboration work as before. The folder is a live copy of it.

This needs the File System Access API, which Chrome, Edge and other Chromium browsers have and Firefox and Safari don't. Where it is missing, the buttons below don't show up. The [command line tool](cli.md) does the same job in any browser, and also works without one open.

## Open a folder as a new project

On the start page, choose **Open local folder** and pick a folder. typstry reads its files, creates a project from them and links the two. The project is named after the folder unless you typed a title first.

The folder must hold something to import, and no more than 10,000 files and folders.

## Link an existing project to a folder

In a project, click **Files** at the top of the file tree and choose **Link to local folder…**. Pick an empty folder to write the project's files into it, or a folder that already has files to merge the two.

If the folder and the project both have a file at the same path with different content, typstry asks which side wins for those files:

- **Use folder versions** is the default. The project's versions stay in History, so nothing is lost.
- **Use project versions** overwrites the folder's files with the project's.

Files that exist on one side only are copied to the other, and files with the same content are left alone.

The menu then offers **Sync folder now** and **Unlink**. Unlinking stops the syncing and leaves every file where it is.

## What syncing does

Edits in the browser are written to the folder shortly after you make them. While the tab is visible, typstry also looks at the folder every few seconds and whenever the window gets focus, and Chromium tells it about changes sooner where it can. A changed, new or deleted file in the folder becomes an edit, a new file or a deletion in the project, and it reaches your collaborators like any other edit.

Syncing only runs while the project is open in a tab. Changes you make to the folder while it is closed are picked up the next time you open the project.

Once linked, the folder's name heads the file tree in place of **Files**, and clicking it opens the folder's actions: sync now, reconnect and unlink. Hover over it for the sync's state. When the sync stalls, a strip under the name says why and offers the way out. A folder that was renamed, moved or deleted shows as missing. Move it back, or unlink it and link the new location.

## Permission after a reload

Chromium forgets the permission to read and write a folder when the page is reloaded or the tab is closed. typstry remembers the link, though. After a reload the indicator turns amber and says **Reconnect &lt;folder&gt;**. Click it and allow access in the prompt that follows. The **Reconnect folder** item in the menu does the same. Nothing syncs until you do, and nothing is lost in the meantime.

The browser only shows its prompt in answer to a click, which is why typstry can't restore access by itself.

## Which files are synced

These are left out, never written to the folder and never deleted from it:

- Files matched by the folder's `.gitignore`, by `.git/info/exclude` and by a `.typstryignore`. The patterns work as they do in git. Ignore files in subfolders apply to their own folder.
- git's own files (`.gitignore`, `.gitattributes`, `.gitmodules`, `.github/`) and `.typstryignore` itself. Re-include one with a negated pattern such as `!.gitignore` in `.typstryignore`. These are listed as skipped.
- A PDF next to a `.typ` file of the same name, such as `thesis.pdf` beside `thesis.typ`. It is most likely the compiled output. To sync it anyway, add `!thesis.pdf` to `.typstryignore`.
- Junk such as `.DS_Store`, `Thumbs.db`, `desktop.ini`, `__MACOSX` and `node_modules`, and the temporary files Chromium writes while saving.
- Files larger than the upload limit, and names that a project can't hold. The latter are listed as skipped.

Text files are synced as text. Anything else is uploaded as an encrypted file, like an image you add in the browser.

## When both sides change

If you edit a text file in the browser and in the folder at the same time, typstry merges the two edits, as the CLI does, and writes the result to both sides. Edits to different parts of the file never clash.

Some changes can't be merged. The folder's version wins in these cases, and the project's version stays in History:

- A binary file, such as an image, changed on both sides.
- A file was edited on one side and deleted on the other. The edit is kept.
- A file changed from text to binary, or the other way round.

Each of these shows up as a conflict. You get a notification, and the warning icon next to the folder's name lists the files and what happened. **Dismiss** clears the list. To get a losing version back, open it in History and restore it.

## Projects you can only view

On a project opened with a view link, typstry copies changes from the project into the folder, but never the other way round. Edits you make in the folder stay there and are listed as not applied.

## Good to know

- The link is stored in this browser only, next to the project, and is not shared with collaborators. Each person can link their own folder.
- Link a folder to one project at a time. Two projects writing into the same folder fight over its files.
- Only one tab syncs a project's folder. The others leave it alone.
- Deleting a project from the start page also forgets its folder link. The folder's files stay.
- If you use git in the folder, treat typstry like a co-author: commit what you want to keep. See [the CLI guide](cli.md) for how git and typstry fit together.
