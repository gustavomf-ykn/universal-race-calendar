"""Interactive owner account on the confirmed new project; no email invitations."""
import json
from pathlib import Path
import runpy
import tkinter as tk
from tkinter import ttk, messagebox
import httpx

ROOT = Path(__file__).resolve().parents[1]
context = runpy.run_path(str(ROOT / "scripts/local-staging.py"))
env = context["environment"]()
BASE = env["SUPABASE_URL"]
headers = {"apikey": env["SUPABASE_SECRET_KEY"]}
window = tk.Tk()
window.title("Runfinder — sua conta no novo Supabase")
window.geometry("610x400")
window.resizable(False, False)
frame = ttk.Frame(window, padding=20)
frame.pack(fill="both", expand=True)
ttk.Label(frame, text="Sua conta de homologação", font=("Segoe UI", 12, "bold")).pack(anchor="w")
ttk.Label(frame, text="Projeto " + context["REF"] + ". Nenhum convite será enviado.").pack(anchor="w", pady=8)
entries = []
for label, hidden in [("Seu email", False), ("Senha nova (mínimo 12 caracteres)", True), ("Confirme a senha", True)]:
    ttk.Label(frame, text=label).pack(anchor="w", pady=(6, 2))
    e = ttk.Entry(frame, show="*" if hidden else "", width=75)
    e.pack(fill="x")
    entries.append(e)
entries[0].insert(0, "gustavomf.empresa@gmail.com")
ttk.Label(frame, text="Guarde a senha no seu gerenciador. Ela não será salva em arquivos ou logs.").pack(anchor="w", pady=14)
def save():
    email, password, confirm = (e.get() for e in entries)
    if "@" not in email or len(password) < 12 or password != confirm:
        messagebox.showerror("Confira os campos", "Informe seu email e duas senhas iguais com pelo menos 12 caracteres.", parent=window)
        return
    try:
        listing = httpx.get(BASE + "/auth/v1/admin/users?page=1&per_page=100", headers=headers, timeout=20)
        if listing.status_code != 200:
            raise RuntimeError()
        existing = [u for u in listing.json().get("users", []) if u.get("email", "").lower() == email.strip().lower()]
        if len(existing) > 1:
            raise RuntimeError()
        if existing:
            user = existing[0]
            response = httpx.put(BASE + "/auth/v1/admin/users/" + user["id"], headers=headers, timeout=20,
                                json={"app_metadata": {**user.get("app_metadata", {}), "role": "admin"}})
            if response.status_code != 200:
                raise RuntimeError()
            text = "A conta existente foi promovida a admin, preservando metadados e senha. Use sua senha anterior ao entrar."
        else:
            response = httpx.post(BASE + "/auth/v1/admin/users", headers=headers, timeout=20,
                                 json={"email": email.strip(), "password": password, "email_confirm": True,
                                       "app_metadata": {"role": "admin"}})
            if response.status_code != 200:
                raise RuntimeError()
            user = response.json()
            text = "Conta criada como admin no novo projeto. Faça login com a senha que acabou de definir após atualizar o painel."
        verify = httpx.get(BASE + "/auth/v1/admin/users/" + user["id"], headers=headers, timeout=20)
        if verify.status_code != 200 or verify.json().get("app_metadata", {}).get("role") != "admin":
            raise RuntimeError()
        (context["RUNTIME"] / "owner-account.json").write_text(json.dumps({
            "projectRef": context["REF"], "userId": user["id"], "adminVerified": True, "passwordStored": False}), encoding="utf-8")
        for entry in entries:
            entry.delete(0, tk.END)
        messagebox.showinfo("Conta pronta", text, parent=window)
        window.destroy()
    except Exception:
        messagebox.showerror("Não concluído", "Não foi possível confirmar a conta. Confira a conexão e tente novamente; nenhum segredo foi exibido.", parent=window)
ttk.Button(frame, text="Preparar minha conta admin", command=save).pack(anchor="e")
window.mainloop()
