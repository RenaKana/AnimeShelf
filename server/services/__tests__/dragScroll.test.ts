import { afterEach, describe, expect, it, vi } from 'vitest'

describe('global drag scrolling', () => {
  const originalDescriptors = new Map<string, PropertyDescriptor | undefined>()

  afterEach(() => {
    for (const [key, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    originalDescriptors.clear()
    vi.resetModules()
  })

  it('preserves native text selection and only cancels a real background drag', async () => {
    class FakeElement {
      parentElement: FakeElement | null = null
      isContentEditable = false
      textContent = ''
      childElementCount = 0
      scrollHeight = 0
      clientHeight = 0
      scrollWidth = 0
      clientWidth = 0
      scrollLeft = 0
      scrollTop = 0
      overflowY = 'visible'
      overflowX = 'visible'
      userSelect = 'text'
    }
    class FakeInput extends FakeElement {}
    class FakeTextarea extends FakeElement {}
    class FakeSelect extends FakeElement {}

    const handlers = new Map<string, (event: any) => void>()
    const body = new FakeElement()
    ;(body as any).style = { userSelect: '', cursor: '' }
    const fakeDocument = {
      body,
      addEventListener(type: string, handler: (event: any) => void) { handlers.set(type, handler) },
    }
    const install = (key: string, value: unknown) => {
      originalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
    }
    install('Element', FakeElement)
    install('HTMLElement', FakeElement)
    install('HTMLInputElement', FakeInput)
    install('HTMLTextAreaElement', FakeTextarea)
    install('HTMLSelectElement', FakeSelect)
    install('document', fakeDocument)
    install('getComputedStyle', (node: FakeElement) => ({ overflowY: node.overflowY, overflowX: node.overflowX, userSelect: node.userSelect }))
    install('requestAnimationFrame', () => 1)

    const scroller = new FakeElement()
    scroller.parentElement = body
    scroller.overflowY = 'auto'
    scroller.scrollHeight = 500
    scroller.clientHeight = 100
    scroller.scrollWidth = scroller.clientWidth = 100

    const text = new FakeElement()
    text.parentElement = scroller
    text.textContent = '这段文字应该可以被复制'

    const background = new FakeElement()
    background.parentElement = scroller

    const { initDragScroll } = await import('../../../src/lib/dragScroll')
    initDragScroll()

    let textDownPrevented = false
    handlers.get('mousedown')!({
      button: 0, target: text, clientX: 10, clientY: 10,
      preventDefault() { textDownPrevented = true },
    })
    expect(textDownPrevented).toBe(false)

    let backgroundDownPrevented = false
    handlers.get('mousedown')!({
      button: 0, target: background, clientX: 10, clientY: 10,
      preventDefault() { backgroundDownPrevented = true },
    })
    expect(backgroundDownPrevented).toBe(false)

    let dragMovePrevented = false
    handlers.get('mousemove')!({
      clientX: 20, clientY: 20,
      preventDefault() { dragMovePrevented = true },
    })
    expect(dragMovePrevented).toBe(true)
  })
})
