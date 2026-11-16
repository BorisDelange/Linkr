/** Data quality: the groups of a rule set's checks — named in English and French,
 *  nested by parent; checks point at a group key. */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { canMoveGroup, groupLabel, moveGroup, newGroupKey, readCheckGroups, removeGroup, removeSubtree, renameGroup, subtreeKeys } from '@/lib/dq-groups'
import type { DqRuleSet } from '@/types'
import { OTHER_GROUP, findGroup, isOtherGroup, ruleSetGroups } from './dq.js'
import { bilingual, frenchParam, localizedChange } from './lab.js'
import { DESTRUCTIVE, WRITE, failure, guard, text, type Server } from './shared.js'
import { RULE_SET_ID, dq, groupFor, groupPathOf, ruleSetOrFail, saveGroups, unknownIds, updateMany } from './tools-dq.js'

const GROUP_REF = { type: 'string', description: 'A group key or name (list_dq_checks).' } as const

/** The group an agent names, or why there is none. */
async function groupOrFail(rs: DqRuleSet, ref: string) {
  const checks = await dq.listChecks(rs.id)
  const groups = ruleSetGroups(rs, checks)
  const group = findGroup(groups, ref)
  if (!group) throw new Error(`No group "${ref}" in this rule set (list_dq_checks lists them).`)
  return { group, groups, checks }
}

export function registerDqGroupTools(server: Server): void {
  server.registerTool('create_dq_check_group', {
    description: 'Create a group of checks in a data-quality rule set, at the top level or inside another group '
      + '(parent), named in English and French like the sidebar\'s New group. move_dq_checks or create_dq_check '
      + '(group) then fills it; an empty group is kept.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ rule_set_id: string; name: string; name_fr?: string; parent?: string }>({
      type: 'object',
      properties: { ...RULE_SET_ID, name: { type: 'string' }, name_fr: frenchParam('name'), parent: GROUP_REF },
      required: ['rule_set_id', 'name'],
    }),
  }, guard(async ({ rule_set_id, name, name_fr, parent }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    if (isOtherGroup(name)) return failure(`name must be a name other than "${OTHER_GROUP}".`)
    const parentKey = parent?.trim() ? (await groupOrFail(rs, parent)).group.key : null
    const groups = ruleSetGroups(rs, await dq.listChecks(rs.id))
    const label = bilingual(name.trim(), name_fr?.trim())
    const clash = groups.find((g) => (g.parentKey ?? null) === parentKey
      && Object.values(g.name).some((n) => Object.values(label).some((l) => l.toLowerCase() === n.toLowerCase())))
    if (clash) return failure(`A group "${groupLabel(clash, 'en')}" (key ${clash.key}) already sits there.`)
    const key = newGroupKey(label, groups.map((g) => g.key))
    await saveGroups(rs, [...readCheckGroups(rs.checkGroups), { key, name: label, parentKey }])
    return text(`Created the group "${label.en}" (key ${key})${parentKey ? ` inside ${parentKey}` : ''}.`)
  }))

  server.registerTool('move_dq_checks', {
    description: 'Move checks of a data-quality rule set to a group (key or name; a new name creates it at the '
      + 'top level), or to "Other checks" with group "". The sidebar does it by drag and drop.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ rule_set_id: string; check_ids: string[]; group: string | null }>({
      type: 'object',
      properties: {
        ...RULE_SET_ID,
        check_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        group: { type: 'string', description: 'Group key or name; "" = "Other checks".' },
      },
      required: ['rule_set_id', 'check_ids', 'group'],
    }),
  }, guard(async ({ rule_set_id, check_ids, group }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    const all = await dq.listChecks(rs.id)
    const problem = unknownIds(all, check_ids)
    if (problem) return failure(problem)
    const existed = isOtherGroup(group) || !!findGroup(ruleSetGroups(rs, all), group!)
    const target = await groupFor(rs, all, group)
    if ('error' in target) return failure(target.error)
    await updateMany(check_ids, { groupKey: target.key })
    const where = target.key ? `"${groupPathOf(rs, all, target.key)}"${existed ? '' : ' (new group)'}` : `"${OTHER_GROUP}"`
    return text(`Moved ${check_ids.length} check(s) to ${where}.`)
  }))

  server.registerTool('rename_dq_check_group', {
    description: 'Rename a group of checks in a data-quality rule set, in English and/or French (name_fr alone '
      + 'changes only the French name). Its key, and so its checks, stay as they are.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ rule_set_id: string; group: string; new_name?: string; new_name_fr?: string }>({
      type: 'object',
      properties: { ...RULE_SET_ID, group: GROUP_REF, new_name: { type: 'string' }, new_name_fr: frenchParam('new_name') },
      required: ['rule_set_id', 'group'],
    }),
  }, guard(async ({ rule_set_id, group, new_name, new_name_fr }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    if (isOtherGroup(group)) return failure(`"${OTHER_GROUP}" cannot be renamed: move its checks with move_dq_checks.`)
    if (new_name !== undefined && isOtherGroup(new_name)) return failure(`new_name must be a name other than "${OTHER_GROUP}".`)
    const { group: g } = await groupOrFail(rs, group)
    const name = localizedChange(g.name, new_name?.trim(), new_name_fr?.trim())
    if (!name) return failure('Give new_name and/or new_name_fr.')
    await saveGroups(rs, renameGroup(readCheckGroups(rs.checkGroups), g.key, name))
    return text(`Renamed the group ${g.key} to "${name.en ?? ''}"${name.fr ? ` / fr "${name.fr}"` : ''}.`)
  }))

  server.registerTool('move_dq_check_group', {
    description: 'Move a group of checks of a data-quality rule set inside another group (parent), or back to the '
      + 'top level with parent "". Its checks and sub-groups move with it. A group cannot go inside one of its own.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ rule_set_id: string; group: string; parent: string }>({
      type: 'object',
      properties: { ...RULE_SET_ID, group: GROUP_REF, parent: { type: 'string', description: 'Group key or name; "" = the top level.' } },
      required: ['rule_set_id', 'group', 'parent'],
    }),
  }, guard(async ({ rule_set_id, group, parent }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    const { group: g, groups } = await groupOrFail(rs, group)
    const parentKey = parent.trim() ? (findGroup(groups, parent)?.key ?? null) : null
    if (parent.trim() && !parentKey) return failure(`No group "${parent}" in this rule set (list_dq_checks lists them).`)
    if (!canMoveGroup(groups, g.key, parentKey)) return failure('A group cannot go inside itself or one of its sub-groups.')
    if ((g.parentKey ?? null) === parentKey) return text('Already there: nothing to do.')
    await saveGroups(rs, moveGroup(readCheckGroups(rs.checkGroups), g.key, parentKey))
    return text(`Moved the group ${g.key} ${parentKey ? `inside ${parentKey}` : 'to the top level'}.`)
  }))

  server.registerTool('delete_dq_check_group', {
    description: 'Delete a group of checks in a data-quality rule set: with its checks and sub-groups (with_checks '
      + 'true; cannot be undone, ask the user first), or keeping them — its checks and sub-groups then move up to '
      + 'the group above. Deleting "Other checks" deletes its checks.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ rule_set_id: string; group: string; with_checks: boolean }>({
      type: 'object',
      properties: { ...RULE_SET_ID, group: GROUP_REF, with_checks: { type: 'boolean' } },
      required: ['rule_set_id', 'group', 'with_checks'],
    }),
  }, guard(async ({ rule_set_id, group, with_checks }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    if (isOtherGroup(group)) {
      const ids = (await dq.listChecks(rs.id)).filter((c) => !c.groupKey).map((c) => c.id)
      if (!with_checks) return failure(`Keeping the checks of "${OTHER_GROUP}" would leave them where they are: pass with_checks true to delete them.`)
      for (const id of ids) await dq.deleteCheck(id)
      return text(`Deleted the ${ids.length} check(s) of "${OTHER_GROUP}".`)
    }
    const { group: g, groups, checks } = await groupOrFail(rs, group)
    const label = groupLabel(g, 'en')
    const declared = readCheckGroups(rs.checkGroups)
    if (with_checks) {
      const keys = subtreeKeys(groups, g.key)
      const ids = checks.filter((c) => c.groupKey && keys.has(c.groupKey)).map((c) => c.id)
      for (const id of ids) await dq.deleteCheck(id)
      await saveGroups(rs, removeSubtree(declared, g.key))
      return text(`Deleted the group "${label}", its sub-groups and their ${ids.length} check(s).`)
    }
    const ids = checks.filter((c) => c.groupKey === g.key).map((c) => c.id)
    await updateMany(ids, { groupKey: g.parentKey ?? null })
    await saveGroups(rs, removeGroup(declared, g.key))
    const up = g.parentKey ? `"${groupPathOf(rs, checks, g.parentKey)}"` : `"${OTHER_GROUP}" (its sub-groups to the top level)`
    return text(`Deleted the group "${label}"; its ${ids.length} check(s) moved up to ${up}.`)
  }))
}
