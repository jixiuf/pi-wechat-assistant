## English

Write the complete English content in this section, followed by the complete corresponding Chinese content below. Do not alternate languages by paragraph or subsection. This format applies to project communication; documentation uses separate language files.

### Summary

Describe the problem and resulting behavior.

Target `develop` for normal changes, or `main` for a release or urgent fix. State the target and reason here. Use a merge commit for `develop -> main`; the maintainer reviews and merges manually after CI passes.

### Validation

- [ ] `npm run check`
- [ ] `npm run typecheck:pi`

Describe manual checks and any checks not run.

### Related issues and compatibility

Link related issues and describe user-facing or compatibility changes, if any.

---

## 中文

先在上方写完整英文，再在本节写完整的对应中文，不按段落或小节交替排列。此格式适用于项目交流；说明文档按语言拆分文件。

### 摘要

说明问题与修改后的行为。

普通改动以 `develop` 为目标，发布或紧急修复以 `main` 为目标；在此说明目标与原因。`develop → main` 使用合并提交；CI 通过后由维护者检查并手动合并。

### 验证

- [ ] `npm run check`
- [ ] `npm run typecheck:pi`

说明手动检查及未执行的检查，与英文版保持一致。

### 关联 issue 与兼容性

关联相关 issue，说明用户可见或兼容性变化（如有）。
