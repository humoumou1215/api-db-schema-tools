# Smoke cases for v0.7.1

1. Plugin registers only one Ribbon action: Schema Studio.
2. Command Palette registers `open-schema-studio`, `install-demo-sample`, and `restore-from-demo-sample`.
3. Demo plan creates a single `_SchemaTools-Demo/` root and no files outside it.
4. Demo plan file paths are unique.
5. Demo contains API docs, DB docs, 中文“体验接口字段/体验数据库字段” classes, Bases, JSON v1/v2, MySQL v1/v2, Oracle DDL, and a design note.
6. Demo Fileclass definitions bind exactly to the demo `_data` folders.
7. Install confirmation lists Schema Tools path changes and, when Fileclass is present, the Fileclass class-folder change.
8. Existing `_SchemaTools-Demo/` is never overwritten; user can open it or switch settings to it.
9. Demo activation backs up Schema Tools paths and Fileclass classFilesPath before switching.
10. Restore returns backed-up settings and leaves demo files untouched.
11. Existing grid dynamic property discovery remains intact.
12. Manual edits still render struck-through persisted value plus pending value before Save.
13. Excel/WPS TSV copy/paste regression: CRLF, tabs, quoted multiline cells and header mapping.
14. JSON nested Object + List<Object> import regression.
15. MySQL / Oracle DDL parser regression.
16. `[[@` inline suggester registration remains unchanged.
17. Escape / Enter / unsaved guard regression from v0.6.2 remains intact.

8. Chinese demo content: user-facing docs/values/comments are Chinese while technical identifiers remain stable.
