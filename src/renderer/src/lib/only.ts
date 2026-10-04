/** Stops a click on a button from also reaching the island shape behind it. */
export function only(action: () => void): (event: { stopPropagation(): void }) => void {
  return (event) => {
    event.stopPropagation()
    action()
  }
}
