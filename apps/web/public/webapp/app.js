// Flagship webapp entry — the keystore + pairing logic is wired in by the
// next module. For now we render a clear "loading" subtitle so the shell
// looks alive on first install.
document.getElementById("subtitle").textContent = "loading…";
console.log("[flagship webapp] shell loaded");
