// Stage 1 accumulator contract tests (A–J). Run against built dist.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectChunks } from '../dist/index.js'

const text = (index, s) => ({ type: 'text-delta', index, text: s })
const blockStart = (index, blockType = 'text') => ({ type: 'block-start', index, blockType })
const blockEndText = (index, t) => ({ type: 'block-end', index, block: { type: 'text', text: t } })
const stop = () => ({ type: 'finish', reason: { kind: 'stop' } })

async function* of(...chunks) {
  for (const c of chunks) yield c
}

test('A: block-start + multiple text-delta + block-end assembles without duplication', async () => {
  const out = await collectChunks(of(blockStart(0), text(0, 'he'), text(0, 'llo'), blockEndText(0, 'hello'), stop()))
  assert.equal(out, 'hello')
})

test('B: text-delta without block-start works', async () => {
  const out = await collectChunks(of(text(1, 'world'), stop()))
  assert.equal(out, 'world')
})

test('C: block-end text without block-start/delta uses the assembled block', async () => {
  const out = await collectChunks(of(blockEndText(0, 'assembled'), stop()))
  assert.equal(out, 'assembled')
})

test('D: block-end after deltas does not duplicate text', async () => {
  const out = await collectChunks(of(text(0, 'ab'), blockEndText(0, 'ab'), stop()))
  assert.equal(out, 'ab')
})

test('E: multi-index output preserves first-observed block order (not block-start order)', async () => {
  // index 2 observed first via block-end, then 0, then 1
  const out = await collectChunks(
    of(blockEndText(2, 'two'), blockStart(0), text(0, 'zero'), blockStart(1), blockEndText(1, 'one'), stop()),
  )
  assert.equal(out, 'twozeroone')
})

test('F: empty result fails closed', async () => {
  await assert.rejects(collectChunks(of(blockStart(0), blockEndText(0, ''), stop())), /no text/)
})

test('G: finish error fails closed with the failure message', async () => {
  await assert.rejects(
    collectChunks(of({ type: 'finish', reason: { kind: 'error', failure: { message: 'vision exploded' } } })),
    /vision stream error: vision exploded/,
  )
})

test('H: finish tool-calls fails closed', async () => {
  await assert.rejects(collectChunks(of({ type: 'finish', reason: { kind: 'tool-calls' } })), /tool-calls/)
})

test('I: stream ends without finish fails closed', async () => {
  await assert.rejects(collectChunks(of(text(0, 'hi'))), /without a finish/)
})

test('J: cancellation propagates the signal reason and stops promptly', async () => {
  const controller = new AbortController()
  controller.abort(new Error('caller cancelled'))
  await assert.rejects(collectChunks(of(blockStart(0)), controller.signal), /caller cancelled/)
})

test('J2: cancellation mid-stream aborts the read instead of draining further', async () => {
  const controller = new AbortController()
  async function* mid() {
    yield blockStart(0)
    yield text(0, 'partial')
    controller.abort(new Error('mid cancel'))
    yield text(0, 'never-seen')
    yield stop()
  }
  await assert.rejects(collectChunks(mid(), controller.signal), /mid cancel/)
})

test('finish aborted fails closed with the stream failure message', async () => {
  await assert.rejects(
    collectChunks(of({ type: 'finish', reason: { kind: 'aborted', failure: { message: 'provider aborted' } } })),
    /vision stream aborted: provider aborted/,
  )
})

test('reasoning-delta, tool-call-delta, and usage chunks are ignored', async () => {
  const out = await collectChunks(
    of(
      blockStart(0),
      { type: 'reasoning-delta', index: 0, text: 'think' },
      text(0, 'answer'),
      { type: 'tool-call-delta', index: 1, id: 't1', name: 'x', argumentsDelta: '{}' },
      { type: 'usage', usage: {} },
      stop(),
    ),
  )
  assert.equal(out, 'answer')
})
