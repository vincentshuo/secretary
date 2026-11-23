# Preserve current state during YouTube cutover and code rollback

**Status: superseded by ADR 0022 (2026-11-23); never implemented.** The server content session this cutover targeted was never built, and Edison no longer acquires YouTube content, so there is nothing to cut over.

YouTube changes to the server-owned content session through one bounded maintenance window, with an independent cutover hold that preserves the person's execution permissions. Existing OAuth is reused only after verification; the content browser receives a fresh formal profile and one explicit initial sign-in. The temporary prototype is not promoted by copying its directory and assuming identity compatibility.

Code rollback must retain the latest knowledge assets, reading records, task state and user permissions. If an earlier program cannot safely use that state, acquisition stays stopped while a compatible reading service is retained. Rewinding the entire workspace or restoring old credentials could erase new work or undo a cancellation or disconnection, so neither is a normal rollback mechanism. Obsolete content credentials are removed after the formal path passes its connection and recovery checks; they are not a second production path. Knowledge-asset backups remain separate.

This deliberately accepts temporary acquisition downtime instead of maintaining two credential writers or promising immediate return to the old Cookie path. The canonical sequence, abort conditions, cleanup boundary and observation-clock rules are in [现有授权与旧入口如何切换到服务器会话](https://github.com/vincentshuo/Edison/issues/46#issuecomment-6258668775).
