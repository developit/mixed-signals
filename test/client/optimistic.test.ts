import {effect, signal} from '@preact/signals-core'
import {describe, expect, it} from 'vitest'
import {
  createOptimistic,
  optimisticList,
  optimisticObject,
  optimisticValue,
} from '../../client/optimistic.ts'

interface Message {
  id: string
  clientId?: string
  role: 'user' | 'assistant'
  text: string
}

function ids(messages: readonly Message[]): string[] {
  return messages.map((message) => message.id)
}

function flush(): Promise<void> {
  return Promise.resolve().then(() => undefined)
}

function key(message: Message): string {
  return message.clientId ?? message.id
}

function message(over: Partial<Message> & {id: string}): Message {
  return {role: 'user', text: '', ...over}
}

describe('createOptimistic', () => {
  it('returns the exact source reference when no patch is live', () => {
    const source = signal([1, 2, 3])
    const overlay = createOptimistic(source)
    expect(overlay.value.peek()).toBe(source.peek())
  })

  it('applies a single patch over the source value without mutating it', () => {
    const source = signal([1, 2])
    const overlay = createOptimistic(source)

    overlay.patch({
      apply: (list) => [...list, 3],
      settled: (server) => server.includes(3),
    })

    expect(source.peek()).toEqual([1, 2])
    expect(overlay.value.peek()).toEqual([1, 2, 3])
  })

  it('folds multiple patches in insertion order', () => {
    const source = signal<number[]>([])
    const overlay = createOptimistic(source)

    overlay.patch({apply: (list) => [...list, 1], settled: () => false})
    overlay.patch({apply: (list) => [...list, 2], settled: () => false})

    expect(overlay.value.peek()).toEqual([1, 2])
  })

  it('lets a later patch win when two patches target the same slot', () => {
    const source = signal(0)
    const overlay = createOptimistic(source)

    overlay.patch({apply: () => 1, settled: () => false})
    overlay.patch({apply: () => 2, settled: () => false})

    expect(overlay.value.peek()).toBe(2)
  })

  it('filters a settled patch out of the value and restores source identity', () => {
    const source = signal<number[]>([])
    const overlay = createOptimistic(source)

    overlay.patch({
      apply: (list) => [...list, 9],
      settled: (server) => server.includes(9),
    })

    expect(overlay.value.peek()).toEqual([9])
    source.value = [9]
    expect(overlay.value.peek()).toBe(source.peek())
  })

  it('does not add a patch that is already settled by the source', () => {
    let watchCount = 0
    const source = signal([9], {
      watched() {
        watchCount++
      },
    })
    const overlay = createOptimistic(source)

    const operation = overlay.patch({
      apply: (list) => [...list, 9],
      settled: (server) => server.includes(9),
    })

    expect(overlay.value.peek()).toBe(source.peek())
    expect(watchCount).toBe(0)
    expect(() => operation.rollback()).not.toThrow()
  })

  it('passes confirmation state to the settled predicate', () => {
    const source = signal('base')
    const overlay = createOptimistic(source)

    const operation = overlay.patch({
      apply: () => 'optimistic',
      settled: (server, confirmed) => confirmed && server !== 'base',
    })

    operation.confirm()
    expect(overlay.value.peek()).toBe('optimistic')

    source.value = 'server'
    expect(overlay.value.peek()).toBe('server')
  })

  it('rolls back a patch on demand', () => {
    const source = signal<number[]>([])
    const overlay = createOptimistic(source)

    const operation = overlay.patch({
      apply: (list) => [...list, 1],
      settled: () => false,
    })

    expect(overlay.value.peek()).toEqual([1])
    operation.rollback()
    expect(overlay.value.peek()).toEqual([])
  })

  it('treats rollback as idempotent and a no-op after settle', () => {
    const source = signal<number[]>([])
    const overlay = createOptimistic(source)

    const operation = overlay.patch({
      apply: (list) => [...list, 1],
      settled: (server) => server.includes(1),
    })

    source.value = [1]
    expect(() => {
      operation.rollback()
      operation.rollback()
    }).not.toThrow()
    expect(overlay.value.peek()).toEqual([1])
  })

  it('treats confirm as idempotent', () => {
    const source = signal('base')
    const overlay = createOptimistic(source)
    const operation = overlay.patch({
      apply: () => 'next',
      settled: (server, confirmed) => confirmed && server !== 'base',
    })

    expect(() => {
      operation.confirm()
      operation.confirm()
    }).not.toThrow()
    expect(overlay.value.peek()).toBe('next')
  })

  it('clears all patches', () => {
    const source = signal<number[]>([])
    const overlay = createOptimistic(source)

    overlay.patch({apply: (list) => [...list, 1], settled: () => false})
    overlay.patch({apply: (list) => [...list, 2], settled: () => false})
    overlay.clear()

    expect(overlay.value.peek()).toEqual([])
  })

  it('is a passthrough after dispose', () => {
    const source = signal<number[]>([])
    const overlay = createOptimistic(source)

    overlay.patch({apply: (list) => [...list, 1], settled: () => false})
    overlay.dispose()

    expect(overlay.value.peek()).toBe(source.peek())

    overlay.patch({apply: (list) => [...list, 2], settled: () => false})
    expect(overlay.value.peek()).toBe(source.peek())
  })
})

describe('createOptimistic actions', () => {
  it('confirms a patch when the bound action resolves', async () => {
    const source = signal('base')
    const overlay = createOptimistic(source)

    overlay.patch(
      {
        apply: () => 'optimistic',
        settled: (server, confirmed) => confirmed && server !== 'base',
      },
      Promise.resolve('ok'),
    )

    await flush()
    expect(overlay.value.peek()).toBe('optimistic')

    source.value = 'server'
    expect(overlay.value.peek()).toBe('server')
  })

  it('rolls back automatically when a bound action rejects', async () => {
    const source = signal<number[]>([])
    const overlay = createOptimistic(source)

    overlay.patch(
      {apply: (list) => [...list, 1], settled: () => false},
      Promise.reject(new Error('nope')),
    )

    expect(overlay.value.peek()).toEqual([1])
    await flush()
    await flush()
    expect(overlay.value.peek()).toEqual([])
  })

  it('keeps the patch applied while a bound action is pending', async () => {
    const source = signal<number[]>([])
    const overlay = createOptimistic(source)
    let resolveAction: () => void = () => undefined
    const action = new Promise<void>((resolve) => {
      resolveAction = resolve
    })

    overlay.patch(
      {apply: (list) => [...list, 1], settled: (server) => server.includes(1)},
      action,
    )

    expect(overlay.value.peek()).toEqual([1])
    resolveAction()
    await flush()
    expect(overlay.value.peek()).toEqual([1])
  })

  it('does not leave a deduped action rejection unhandled', async () => {
    const source = signal([1])
    const overlay = createOptimistic(source)

    expect(() =>
      overlay.patch(
        {apply: (list) => [...list, 1], settled: (server) => server.includes(1)},
        Promise.reject(new Error('handled')),
      ),
    ).not.toThrow()

    await flush()
    await flush()
  })

  it('does not throw when an action settles after dispose', async () => {
    const source = signal<number[]>([])
    const overlay = createOptimistic(source)

    overlay.patch(
      {apply: (list) => [...list, 1], settled: () => false},
      Promise.reject(new Error('late')),
    )
    overlay.dispose()

    await flush()
    await flush()
    expect(overlay.value.peek()).toBe(source.peek())
  })
})

describe('createOptimistic reactivity', () => {
  it('notifies observers as a patch is applied then settled, with no stale frame', () => {
    const source = signal<Message[]>([])
    const messages = optimisticList(source, {key})
    const frames: string[][] = []

    const stop = messages.value.subscribe((value) => frames.push(ids(value)))
    messages.insert(message({id: 'local-1', clientId: 'c1'}))
    source.value = [message({id: 'server-1', clientId: 'c1'})]
    stop()

    expect(frames).toEqual([[], ['local-1'], ['server-1']])
  })

  it('does not flicker between action resolve and the source delta', async () => {
    const source = signal('old')
    const value = optimisticValue(source)
    let resolveAction: () => void = () => undefined
    const action = new Promise<void>((resolve) => {
      resolveAction = resolve
    })

    value.set('new', action)
    const frames: string[] = []
    const stop = value.value.subscribe((current) => frames.push(current))

    resolveAction()
    await flush()
    source.value = 'new'
    stop()

    expect(frames).not.toContain('old')
    expect(frames.at(-1)).toBe('new')
  })
})

describe('createOptimistic lifecycle', () => {
  it('does not watch the source until a patch needs reconciliation', () => {
    let watchCount = 0
    const source = signal<number[]>([], {
      watched() {
        watchCount++
      },
    })
    createOptimistic(source)
    expect(watchCount).toBe(0)
  })

  it('watches the source while patches are pending and releases it when empty', () => {
    let watchCount = 0
    let unwatchCount = 0
    const source = signal<number[]>([], {
      watched() {
        watchCount++
      },
      unwatched() {
        unwatchCount++
      },
    })
    const overlay = createOptimistic(source)

    const operation = overlay.patch({
      apply: (list) => [...list, 1],
      settled: (server) => server.includes(1),
    })

    expect(watchCount).toBe(1)
    expect(unwatchCount).toBe(0)

    operation.rollback()
    expect(unwatchCount).toBe(1)
  })

  it('keeps the prune subscription after external observers detach', () => {
    let unwatchCount = 0
    const source = signal<number[]>([], {
      unwatched() {
        unwatchCount++
      },
    })
    const overlay = createOptimistic(source)

    overlay.patch({
      apply: (list) => [...list, 1],
      settled: (server) => server.includes(1),
    })

    const stopValue = overlay.value.subscribe(() => undefined)
    stopValue()
    expect(unwatchCount).toBe(0)

    source.value = [1]
    expect(unwatchCount).toBe(1)
    expect(overlay.value.peek()).toEqual([1])
  })

  it('prunes settled patches even when the value is never observed', () => {
    let unwatchCount = 0
    const source = signal<number[]>([], {
      unwatched() {
        unwatchCount++
      },
    })
    const overlay = createOptimistic(source)

    overlay.patch({
      apply: (list) => [...list, 1],
      settled: (server) => server.includes(1),
    })

    source.value = [1]
    expect(unwatchCount).toBe(1)
    expect(overlay.value.peek()).toEqual([1])
  })

  it('rolls back from an effect without creating a signal cycle', () => {
    const source = signal<number[]>([])
    const failed = signal(false)
    const overlay = createOptimistic(source)
    const operation = overlay.patch({
      apply: (list) => [...list, 1],
      settled: () => false,
    })

    const stop = effect(() => {
      if (failed.value) operation.rollback()
    })

    expect(() => {
      failed.value = true
    }).not.toThrow()

    stop()
    expect(overlay.value.peek()).toEqual([])
  })

  it('keeps pruning active after a reentrant patch during removal', () => {
    const source = signal<number[]>([])
    const overlay = createOptimistic(source)
    const operation = overlay.patch({
      apply: (list) => [...list, 1],
      settled: (server) => server.includes(1),
    })
    let inserted = false

    const stop = effect(() => {
      if (overlay.value.value.length !== 0 || inserted) return
      inserted = true
      overlay.patch({
        apply: (list) => [...list, 2],
        settled: (server) => server.includes(2),
      })
    })

    operation.rollback()
    stop()

    source.value = [2]
    source.value = []

    expect(overlay.value.peek()).toEqual([])
  })
})

describe('optimisticList', () => {
  it('overlays inserted items without mutating the source signal', () => {
    const source = signal<Message[]>([message({id: 'server-1', role: 'assistant'})])
    const messages = optimisticList(source, {key})

    messages.insert(message({id: 'local-1', clientId: 'c1'}))

    expect(ids(source.peek())).toEqual(['server-1'])
    expect(ids(messages.value.peek())).toEqual(['server-1', 'local-1'])
    expect(ids(messages.pending.peek())).toEqual(['local-1'])
  })

  it('dedupes a pending insert when the server reflects the same key', () => {
    const source = signal<Message[]>([])
    const messages = optimisticList(source, {key})

    messages.insert(message({id: 'local-1', clientId: 'c1'}))
    source.value = [message({id: 'server-1', clientId: 'c1'})]

    expect(ids(messages.value.peek())).toEqual(['server-1'])
    expect(messages.pending.peek()).toEqual([])
  })

  it('does not add an insert already confirmed by the source', () => {
    const source = signal<Message[]>([message({id: 'server-1', clientId: 'c1'})])
    const messages = optimisticList(source, {key})

    messages.insert(message({id: 'local-1', clientId: 'c1'}))

    expect(ids(messages.value.peek())).toEqual(['server-1'])
    expect(messages.pending.peek()).toEqual([])
  })

  it('does not resurrect confirmed items after server removal', () => {
    const source = signal<Message[]>([])
    const messages = optimisticList(source, {key})

    messages.insert(message({id: 'local-1', clientId: 'c1'}))
    source.value = [message({id: 'server-1', clientId: 'c1'})]
    source.value = []

    expect(messages.value.peek()).toEqual([])
    expect(messages.pending.peek()).toEqual([])
  })

  it('does not resurrect confirmed items after observed server removal', () => {
    const source = signal<Message[]>([])
    const messages = optimisticList(source, {key})

    messages.insert(message({id: 'local-1', clientId: 'c1'}))
    const stop = messages.value.subscribe(() => undefined)

    source.value = [message({id: 'server-1', clientId: 'c1'})]
    source.value = []
    stop()

    expect(messages.value.peek()).toEqual([])
    expect(messages.pending.peek()).toEqual([])
  })

  it('keeps non-repeating server deltas while removing confirmed optimism', () => {
    const source = signal<Message[]>([])
    const messages = optimisticList(source, {key})

    messages.insert(message({id: 'local-1', clientId: 'c1'}))
    source.value = [
      message({id: 'server-1', clientId: 'c1'}),
      message({id: 'assistant-1', role: 'assistant'}),
    ]

    expect(ids(messages.value.peek())).toEqual(['server-1', 'assistant-1'])
    expect(messages.pending.peek()).toEqual([])
  })

  it('dedupes after a full source replacement that preserves an existing item', () => {
    const source = signal<Message[]>([message({id: 'assistant-1', role: 'assistant'})])
    const messages = optimisticList(source, {key})

    messages.insert(message({id: 'local-1', clientId: 'c1'}))
    source.value = [
      message({id: 'assistant-1', role: 'assistant'}),
      message({id: 'server-1', clientId: 'c1'}),
    ]

    expect(ids(messages.value.peek())).toEqual(['assistant-1', 'server-1'])
    expect(messages.pending.peek()).toEqual([])
  })

  it('preserves multiple pending inserts in insertion order', () => {
    const source = signal<Message[]>([message({id: 'assistant-1', role: 'assistant'})])
    const messages = optimisticList(source, {key})

    messages.insert(message({id: 'local-1', clientId: 'c1'}))
    messages.insert(message({id: 'local-2', clientId: 'c2'}))

    expect(ids(messages.value.peek())).toEqual([
      'assistant-1',
      'local-1',
      'local-2',
    ])
  })

  it('uses a custom match function for server correlation ids', () => {
    const source = signal<Message[]>([])
    const messages = optimisticList(source, {
      key: (item) => item.id,
      match: (server, optimistic) =>
        server.clientId !== undefined && server.clientId === optimistic.clientId,
    })

    messages.insert(message({id: 'local-1', clientId: 'c1'}))
    source.value = [message({id: 'server-1', clientId: 'c1'})]

    expect(ids(messages.value.peek())).toEqual(['server-1'])
    expect(messages.pending.peek()).toEqual([])
  })

  it('hides a removed item until the server drops it', () => {
    const source = signal<Message[]>([message({id: 'server-1', clientId: 'c1'})])
    const messages = optimisticList(source, {key})

    messages.remove(message({id: 'server-1', clientId: 'c1'}))
    expect(messages.value.peek()).toEqual([])
    expect(messages.pending.peek()).toEqual([])

    source.value = []
    expect(messages.value.peek()).toEqual([])
  })

  it('restores a removed item when the action rejects', async () => {
    const source = signal<Message[]>([message({id: 'server-1', clientId: 'c1'})])
    const messages = optimisticList(source, {key})

    messages.remove(
      message({id: 'server-1', clientId: 'c1'}),
      Promise.reject(new Error('failed')),
    )
    expect(messages.value.peek()).toEqual([])

    await flush()
    await flush()
    expect(ids(messages.value.peek())).toEqual(['server-1'])
  })

  it('overlays an edit and settles when the source reflects the change', () => {
    const source = signal<Message[]>([
      message({id: 'server-1', clientId: 'c1', text: 'hi'}),
    ])
    const messages = optimisticList(source, {key})

    messages.edit(message({id: 'server-1', clientId: 'c1'}), {text: 'edited'})
    expect(messages.value.peek()[0].text).toBe('edited')
    expect(messages.pending.peek()).toEqual([])

    source.value = [message({id: 'server-1', clientId: 'c1', text: 'edited'})]
    expect(messages.value.peek()).toBe(source.peek())
  })

  it('settles an edit of a non-primitive change once the action confirms', async () => {
    const source = signal<Message[]>([message({id: 'server-1', clientId: 'c1'})])
    const messages = optimisticList(source, {key})

    messages.edit(
      message({id: 'server-1', clientId: 'c1'}),
      {role: 'assistant'},
      Promise.resolve(),
    )
    await flush()

    // A fresh server item supersedes the optimistic edit after confirmation.
    source.value = [message({id: 'server-1', clientId: 'c1', role: 'assistant'})]
    expect(messages.value.peek()).toBe(source.peek())
  })

  it('composes an insert then an edit of the same key', () => {
    const source = signal<Message[]>([])
    const messages = optimisticList(source, {key})

    messages.insert(message({id: 'local-1', clientId: 'c1', text: 'one'}))
    messages.edit(message({id: 'local-1', clientId: 'c1'}), {text: 'two'})

    expect(messages.value.peek()[0].text).toBe('two')
  })

  it('cancels a pending insert when the same item is removed', () => {
    const source = signal<Message[]>([])
    const messages = optimisticList(source, {key})

    const local = message({id: 'local-1', clientId: 'c1'})
    messages.insert(local)
    messages.remove(local)

    expect(messages.value.peek()).toEqual([])
    expect(messages.pending.peek()).toEqual([])
  })

  it('cancels a pending insert and its edit when the item is removed', () => {
    const source = signal<Message[]>([])
    const messages = optimisticList(source, {key})

    messages.insert(message({id: 'local-1', clientId: 'c1', text: 'one'}))
    messages.edit(message({id: 'local-1', clientId: 'c1'}), {text: 'two'})
    messages.remove(message({id: 'local-1', clientId: 'c1'}))

    expect(messages.value.peek()).toEqual([])
  })

  it('keeps a confirmed edit when an unrelated full-list delta arrives', async () => {
    const source = signal<Message[]>([
      message({id: 's1', clientId: 'c1', text: 'orig'}),
      message({id: 's2', text: 'a'}),
    ])
    const messages = optimisticList(source, {key})

    messages.edit(
      message({id: 's1', clientId: 'c1'}),
      {text: 'edited'},
      Promise.resolve(),
    )
    await flush()
    expect(messages.value.peek()[0].text).toBe('edited')

    // A full-list replacement (e.g. another user edits s2) carries fresh item
    // identities but leaves s1's edited field untouched: the edit must survive.
    source.value = [
      message({id: 's1', clientId: 'c1', text: 'orig'}),
      message({id: 's2', text: 'b'}),
    ]
    expect(messages.value.peek()[0].text).toBe('edited')
  })

  it('rolls back a pending insert when the action rejects', async () => {
    const source = signal<Message[]>([])
    const messages = optimisticList(source, {key})

    messages.insert(
      message({id: 'local-1', clientId: 'c1'}),
      Promise.reject(new Error('failed')),
    )

    expect(ids(messages.value.peek())).toEqual(['local-1'])
    await flush()
    await flush()
    expect(messages.value.peek()).toEqual([])
  })

  it('keeps a resolved insert until the source confirms it', async () => {
    const source = signal<Message[]>([])
    const messages = optimisticList(source, {key})

    messages.insert(message({id: 'local-1', clientId: 'c1'}), Promise.resolve())
    await flush()

    expect(ids(messages.value.peek())).toEqual(['local-1'])

    source.value = [message({id: 'server-1', clientId: 'c1'})]
    expect(ids(messages.value.peek())).toEqual(['server-1'])
  })

  it('rolls back only the rejected one of two concurrent inserts', async () => {
    const source = signal<Message[]>([])
    const messages = optimisticList(source, {key})

    messages.insert(message({id: 'local-1', clientId: 'c1'}), Promise.resolve())
    messages.insert(
      message({id: 'local-2', clientId: 'c2'}),
      Promise.reject(new Error('failed')),
    )

    await flush()
    await flush()
    expect(ids(messages.value.peek())).toEqual(['local-1'])
  })

  it('reuses the overlay after clear', () => {
    const source = signal<Message[]>([])
    const messages = optimisticList(source, {key})

    messages.insert(message({id: 'local-1', clientId: 'c1'}))
    messages.clear()
    messages.insert(message({id: 'local-2', clientId: 'c2'}))

    expect(ids(messages.value.peek())).toEqual(['local-2'])
  })

  it('clears pending items on dispose', () => {
    const source = signal<Message[]>([])
    const messages = optimisticList(source, {key})

    messages.insert(message({id: 'local-1', clientId: 'c1'}))
    messages.dispose()

    expect(messages.value.peek()).toEqual([])
    expect(messages.pending.peek()).toEqual([])
  })
})

describe('optimisticObject', () => {
  interface Profile {
    name: string
    bio?: string
  }

  it('overlays a property without mutating the source', () => {
    const source = signal<Profile>({name: 'old'})
    const profile = optimisticObject(source)

    profile.set('name', 'new')

    expect(source.peek()).toEqual({name: 'old'})
    expect(profile.value.peek()).toEqual({name: 'new'})
  })

  it('settles a set when the server reflects the value', () => {
    const source = signal<Profile>({name: 'old'})
    const profile = optimisticObject(source)

    profile.set('name', 'new')
    source.value = {name: 'new'}

    expect(profile.value.peek()).toBe(source.peek())
  })

  it('does not settle a set on an unrelated source change before confirm', () => {
    const source = signal<Profile>({name: 'old', bio: 'a'})
    const profile = optimisticObject(source)

    profile.set('name', 'new')
    source.value = {name: 'old', bio: 'b'}

    expect(profile.value.peek().name).toBe('new')
  })

  it('settles a normalized value through a custom equals', () => {
    const source = signal<Profile>({name: 'old'})
    const profile = optimisticObject(source, {
      equals: (server, optimistic) =>
        typeof server === 'string' && typeof optimistic === 'string'
          ? server.trim() === optimistic.trim()
          : Object.is(server, optimistic),
    })

    profile.set('name', '  hi  ')
    expect(profile.value.peek().name).toBe('  hi  ')

    // The server reflects a normalized (trimmed) value, equal under `equals`.
    source.value = {name: 'hi'}
    expect(profile.value.peek()).toBe(source.peek())
  })

  it('keeps a newer set when a stale delta for an older set arrives', async () => {
    const source = signal<Profile>({name: 'old'})
    const profile = optimisticObject(source)

    profile.set('name', 'A')
    profile.set('name', 'B', Promise.resolve())
    await flush()
    expect(profile.value.peek().name).toBe('B')

    // A late delta carrying the superseded 'A' write must not revert the overlay.
    source.value = {name: 'A'}
    expect(profile.value.peek().name).toBe('B')
  })

  it('cancels an optimistic set by setting the source value back', () => {
    const source = signal<Profile>({name: 'old'})
    const profile = optimisticObject(source)

    profile.set('name', 'new')
    profile.set('name', 'old')

    expect(profile.value.peek()).toBe(source.peek())
  })

  it('does not resurrect a deleted optimistic-only property after confirm', async () => {
    const source = signal<Profile>({name: 'jane'})
    const profile = optimisticObject(source)

    profile.set('bio', 'hello', Promise.resolve())
    profile.delete('bio', Promise.resolve())
    await flush()
    await flush()

    expect(profile.value.peek()).toEqual({name: 'jane'})
  })

  it('lets the last set win for the same key', () => {
    const source = signal<Profile>({name: 'old'})
    const profile = optimisticObject(source)

    profile.set('name', 'a')
    profile.set('name', 'b')

    expect(profile.value.peek().name).toBe('b')
  })

  it('dedupes a set of the identical current value', () => {
    let watchCount = 0
    const source = signal<Profile>(
      {name: 'same'},
      {
        watched() {
          watchCount++
        },
      },
    )
    const profile = optimisticObject(source)

    profile.set('name', 'same')

    expect(profile.value.peek()).toBe(source.peek())
    expect(watchCount).toBe(0)
  })

  it('deletes a property optimistically and settles when the key is dropped', () => {
    const source = signal<Profile>({name: 'jane', bio: 'hi'})
    const profile = optimisticObject(source)

    profile.delete('bio')
    expect(profile.value.peek()).toEqual({name: 'jane'})

    source.value = {name: 'jane'}
    expect(profile.value.peek()).toBe(source.peek())
  })

  it('composes a set then a delete of the same key', () => {
    const source = signal<Profile>({name: 'jane'})
    const profile = optimisticObject(source)

    profile.set('bio', 'hello')
    profile.delete('bio')

    expect(profile.value.peek()).toEqual({name: 'jane'})
  })

  it('rolls back a set when the action rejects', async () => {
    const source = signal<Profile>({name: 'old'})
    const profile = optimisticObject(source)

    profile.set('name', 'new', Promise.reject(new Error('x')))

    expect(profile.value.peek().name).toBe('new')
    await flush()
    await flush()
    expect(profile.value.peek().name).toBe('old')
  })

  it('restores a deleted property when the action rejects', async () => {
    const source = signal<Profile>({name: 'jane', bio: 'hi'})
    const profile = optimisticObject(source)

    profile.delete('bio', Promise.reject(new Error('x')))
    expect(profile.value.peek()).toEqual({name: 'jane'})

    await flush()
    await flush()
    expect(profile.value.peek()).toEqual({name: 'jane', bio: 'hi'})
  })

  it('rejects a wrongly-typed property value at compile time', () => {
    const source = signal<Profile>({name: 'old'})
    const profile = optimisticObject(source)
    // @ts-expect-error name is a string, not a number
    profile.set('name', 123)
    profile.clear()
  })
})

describe('optimisticValue', () => {
  it('overlays a value without mutating the source', () => {
    const source = signal('old')
    const value = optimisticValue(source)

    value.set('new')

    expect(source.peek()).toBe('old')
    expect(value.value.peek()).toBe('new')
  })

  it('settles when the server reaches the target value', () => {
    const source = signal('old')
    const value = optimisticValue(source)

    value.set('new')
    source.value = 'new'

    expect(value.value.peek()).toBe(source.peek())
  })

  it('does not settle on an unrelated source change before confirm', () => {
    const source = signal('old')
    const value = optimisticValue(source)

    value.set('new')
    source.value = 'unrelated'

    expect(value.value.peek()).toBe('new')
  })

  it('settles a normalized value through a custom equals', () => {
    const source = signal('old')
    const value = optimisticValue(source, {
      equals: (server, optimistic) => server.trim() === optimistic.trim(),
    })

    value.set('  hi  ')
    expect(value.value.peek()).toBe('  hi  ')

    // The server reflects a trimmed value, equal under `equals`.
    source.value = 'hi'
    expect(value.value.peek()).toBe('hi')
  })

  it('keeps a newer set when a stale delta for an older set arrives', async () => {
    const source = signal('old')
    const value = optimisticValue(source)

    value.set('A')
    value.set('B', Promise.resolve())
    await flush()
    expect(value.value.peek()).toBe('B')

    // A late delta carrying the superseded 'A' write must not revert to 'A'.
    source.value = 'A'
    expect(value.value.peek()).toBe('B')
  })

  it('cancels an optimistic set by setting the source value back', () => {
    const source = signal('old')
    const value = optimisticValue(source)

    value.set('new')
    value.set('old')

    expect(value.value.peek()).toBe(source.peek())
  })

  it('keeps a custom-equals value pending until the server matches', () => {
    const source = signal({count: 0})
    const value = optimisticValue(source, {
      equals: (server, optimistic) => server.count === optimistic.count,
    })

    value.set({count: 1})
    source.value = {count: 5}
    expect(value.value.peek()).toEqual({count: 1})

    source.value = {count: 1}
    expect(value.value.peek()).toBe(source.peek())
  })

  it('rolls back when the action rejects', async () => {
    const source = signal('old')
    const value = optimisticValue(source)

    value.set('new', Promise.reject(new Error('x')))

    expect(value.value.peek()).toBe('new')
    await flush()
    await flush()
    expect(value.value.peek()).toBe('old')
  })
})
