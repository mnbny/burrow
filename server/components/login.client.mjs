const toast = document.getElementById('sign-in-error')
const close = toast.querySelector('button')
let timer

function dismiss() {
  clearTimeout(timer)
  if (toast.contains(document.activeElement)) document.getElementById('u').focus()
  toast.remove()
}

function startTimer() {
  clearTimeout(timer)
  if (toast.isConnected && !toast.matches(':hover, :focus-within')) timer = setTimeout(dismiss, 5000)
}

close.hidden = false
close.addEventListener('click', dismiss)
toast.addEventListener('pointerenter', () => clearTimeout(timer))
toast.addEventListener('pointerleave', startTimer)
toast.addEventListener('focusin', () => clearTimeout(timer))
toast.addEventListener('focusout', () => queueMicrotask(startTimer))
startTimer()
