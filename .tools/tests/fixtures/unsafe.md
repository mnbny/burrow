# Untrusted Markdown

The viewer must keep its controls usable when a document contains HTML.

<script>window.burrowXss = true</script>
<img src="./missing.png" onerror="window.burrowXss = true" />
<svg onload="window.burrowXss = true"></svg>
<iframe srcdoc="<script>parent.burrowXss = true</script>"></iframe>
<style>body { display: none }</style>
<form action="./report.md"><input name="location" /></form>
<div id="burrow-source" class="fixed inset-0" style="position:fixed;inset:0">Harmless text.</div>

[Unsafe link](javascript:window.burrowXss=true)

```html
<script>
  This is a code example, not executable HTML.
</script>
```
