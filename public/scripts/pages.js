document.addEventListener("submit", (event) => {
    const form = event.target.closest("form[data-confirm]")
    if (form && !window.confirm(form.dataset.confirm)) event.preventDefault()
})

const roleSelect = document.getElementById("role-select")
if (roleSelect) {
    const defaults = JSON.parse(roleSelect.dataset.defaultPermissions)
    roleSelect.addEventListener("change", () => {
        document.querySelectorAll("[data-role-permission]").forEach((input) => {
            input.checked = defaults[roleSelect.value].includes(input.value)
        })
    })
}
