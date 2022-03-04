/* eslint-env browser */
import { addons, useEffect, useGlobals, useParameter } from "@storybook/addons"
import { DOCS_RENDERED, STORY_CHANGED, STORY_RENDERED, SELECT_STORY, NAVIGATE_URL } from "@storybook/core-events"

import { PSEUDO_STATES } from "./constants"

const pseudoStates = Object.values(PSEUDO_STATES)
const matchOne = new RegExp(`:(${pseudoStates.join("|")})`)
const matchAll = new RegExp(`([^(]):(${pseudoStates.join("|")})`, "g")

// Drops any existing pseudo state classnames that carried over from a previously viewed story
// before adding the new classnames. We do this the old-fashioned way, for IE compatibility.
const applyClasses = (element, classnames) => {
  element.className = element.className
    .split(" ")
    .filter((classname) => classname && classname.indexOf("pseudo-") !== 0)
    .concat(...classnames)
    .join(" ")
}

// Traverses ancestry to collect relevant pseudo classnames, and applies them to the shadow host.
// Shadow DOM can only access classes on its host. Traversing is needed to mimic the CSS cascade.
const updateShadowHost = (shadowHost) => {
  const before = performance.now();
  console.log('START: 🕶 Updating shadow root...')

  const classnames = new Set()
  for (let element = shadowHost.parentElement; element; element = element.parentElement) {
    if (!element.className) continue
    element.className
      .split(" ")
      .filter((classname) => classname.indexOf("pseudo-") === 0)
      .forEach((classname) => classnames.add(classname))
  }
  applyClasses(shadowHost, classnames)

  console.log('FINISH: 🕶 Updating shadow root...', performance.now() - before)
}

// Rudimentary flag to only rewrite stylesheets on initial render
let stylesheetsRewritten = false;

// Keep track of attached shadow host elements for the current story
const shadowHosts = new Set()

const reset = () => {
  stylesheetsRewritten = false;
  shadowHosts.clear();
}

addons.getChannel().on(NAVIGATE_URL, (args) => {
  console.log('NAVIGATE_URL', args)
  return reset();
})
addons.getChannel().on(STORY_CHANGED, (args) => {
  console.log('STORY_CHANGED', args)
  return reset();
})

// Global decorator that rewrites stylesheets and applies classnames to render pseudo styles
export const withPseudoState = (StoryFn, { viewMode, parameters, id }) => {
  const isDocs = viewMode === 'docs';
  const { pseudo: parameter } = parameters;
  const [{ pseudo: globals }, updateGlobals] = useGlobals()

  // Sync parameter to globals, used by the toolbar (only in canvas as this
  // doesn't make sense for docs because many stories are displayed at once)
  useEffect(() => {
    if (parameter !== globals && !isDocs) updateGlobals({ pseudo: parameter })
  }, [parameter, isDocs])

  // Convert selected states to classnames and apply them to the story root element.
  // Then update each shadow host to redetermine its own pseudo classnames.
  useEffect(() => {
    const apply = element => {
      applyClasses(
        element,
        Object.entries(parameter || {})
          .filter(([_, value]) => value)
          .map(([key]) => `pseudo-${PSEUDO_STATES[key]}`)
      )
      shadowHosts.forEach(updateShadowHost)
    }

    if (isDocs) {
      // Wait for the docs page to render so we can select the story element 😑
      setTimeout(() => apply(document.getElementById(`story--${id}`)), 0);
    } else {
      apply(document.getElementById("root"));
    }
  }, [parameter])

  return StoryFn()
}

const warnings = new Set()
const warnOnce = (message) => {
  if (warnings.has(message)) return
  // eslint-disable-next-line no-console
  console.warn(message)
  warnings.add(message)
}

// Rewrite CSS rules for pseudo-states on all stylesheets to add an alternative selector
function rewriteStyleSheets(shadowRoot) {
  if (stylesheetsRewritten) return;

  stylesheetsRewritten = true;

  const before = performance.now();
  console.log('START: ✍🏻 Re-writing stylesheets...')

  for (const sheet of (shadowRoot || document).styleSheets) {
    try {
      let index = 0
      for (const { cssText, selectorText } of sheet.cssRules) {
        if (matchOne.test(selectorText)) {
          const newRule = cssText.replace(
            selectorText,
            selectorText
              .split(", ")
              .flatMap((selector) => {
                if (selector.includes(`.pseudo-`)) return []
                const states = []
                const plainSelector = selector.replace(matchAll, (_, before, state) => {
                  states.push(`.pseudo-${state}`)
                  return before
                })
                const stateSelector = shadowRoot
                  ? `:host(${states.join("")}) ${plainSelector}`
                  : `${states.join("")} ${plainSelector}`
                return [selector, stateSelector]
              })
              .join(", ")
          )
          sheet.deleteRule(index)
          sheet.insertRule(newRule, index)
          if (shadowRoot) shadowHosts.add(shadowRoot.host)
        }
        index++
        if (index > 1000) {
          warnOnce("Reached maximum of 1000 pseudo selectors per sheet, skipping the rest.")
          break
        }
      }
    } catch (e) {
      if (e.toString().includes("cssRules")) {
        warnOnce(`Can't access cssRules, likely due to CORS restrictions: ${sheet.href}`)
      } else {
        // eslint-disable-next-line no-console
        console.error(e, sheet.href)
      }
    }
  }

  console.log('FINISH: ✍🏻 Re-writing stylesheets...', performance.now() - before)
}

// Reinitialize CSS enhancements every time the story changes
addons.getChannel().on(STORY_RENDERED, () => rewriteStyleSheets())

// Reinitialize CSS enhancements every time a docs page is rendered
addons.getChannel().on(DOCS_RENDERED, () => rewriteStyleSheets())

// IE doesn't support shadow DOM
if (Element.prototype.attachShadow) {
  // Monkeypatch the attachShadow method so we can handle pseudo styles inside shadow DOM
  Element.prototype._attachShadow = Element.prototype.attachShadow
  Element.prototype.attachShadow = function attachShadow(init) {
    // Force "open" mode, so we can access the shadowRoot
    const shadowRoot = this._attachShadow({ ...init, mode: "open" })
    // Wait for it to render and apply its styles before rewriting them
    requestAnimationFrame(() => {
      rewriteStyleSheets(shadowRoot)
      updateShadowHost(shadowRoot.host)
    })
    return shadowRoot
  }
}
