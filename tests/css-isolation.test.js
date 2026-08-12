// Verifies that extension CSS does not leak into host pages.
// Regressions to guard against:
//   - tokens.css injected via content_scripts sets :root CSS variables (e.g. --font-family)
//     which override the host page's own CSS custom properties.
//   - Generic class names (e.g. .warning) injected without ID-scoping pollute host page CSS.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readJSON(file) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

function readCSS(file) {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

describe('Content-script CSS isolation', () => {
    test('manifest.json does not inject tokens.css into host pages', () => {
        const manifest = readJSON('manifest.json');
        const contentScriptCss = manifest.content_scripts.flatMap(cs => cs.css || []);
        expect(contentScriptCss).not.toContain('tokens.css');
    });

    test('manifest-firefox.json does not inject tokens.css into host pages', () => {
        const manifest = readJSON('manifest-firefox.json');
        const contentScriptCss = manifest.content_scripts.flatMap(cs => cs.css || []);
        expect(contentScriptCss).not.toContain('tokens.css');
    });

    test('overlay.css does not set CSS variables on :root', () => {
        const css = readCSS('overlay.css');
        // :root variable definitions in a content-script CSS leak to the whole host page
        expect(css).not.toMatch(/:root\s*\{[^}]*--/);
    });

    test('overlay.css contains scoped variable definitions for the overlay element', () => {
        const css = readCSS('overlay.css');
        // Variables must be defined on the overlay element itself, not on :root
        expect(css).toMatch(/#website-time-blocking-overlay\s*\{[^}]*--wtb-/);
    });

    test('overlay.css warning class is prefixed to avoid host-page conflicts', () => {
        const css = readCSS('overlay.css');
        // No standalone .warning rule — only the prefixed .wtb-warning scoped under the ID
        expect(css).not.toMatch(/(?<!#website-time-blocking-overlay)\.warning\b/);
        expect(css).toContain('.wtb-warning');
    });

    test('content.js uses prefixed wtb-warning class, not generic warning', () => {
        const js = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
        // The generic 'warning' class must not be added/removed directly
        expect(js).not.toMatch(/classList\.(add|remove)\(['"]warning['"]\)/);
        expect(js).toMatch(/classList\.(add|remove)\(['"]wtb-warning['"]\)/);
    });
});
