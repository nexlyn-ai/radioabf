// src/scripts/dedications-global.js – chargé une seule fois
(() => {
  if (window.__dedicationsLoaded) return;
  window.__dedicationsLoaded = true;

  const getContainers = () => document.querySelectorAll('.animate-marquee');

  async function loadDedications() {
    try {
      const res = await fetch(
        "https://cms.radioabf.com/items/dedications?" +
        "fields=name,message" +
        "&filter[status][_eq]=published" +
        "&sort=-date_created" +
        "&limit=20"
      );

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const items = data?.data || [];

      let html = "";
      if (items.length === 0) {
        html = '<span class="italic opacity-70">Aucune dédicace pour le moment… Envoie la tienne ! 🎤</span>';
      } else {
        html = items.map(item => `
          <span>
            <strong class="text-cyan-300">${item.name || "Auditeur Anonyme"}</strong> : 
            ${item.message.trim()}
          </span>
        `).join("  •  ");
      }

      // Duplication seulement si assez de contenu (évite un doublon visible quand très peu de messages)
      const finalContent = (items.length <= 3) ? html : html + "  •  " + html;

      getContainers().forEach(container => {
        container.innerHTML = finalContent;
      });

      // Optionnel : ajuster la vitesse selon la quantité de texte
      if (items.length > 0) {
        const baseDuration = 60;                    // secondes minimum
        const charsApprox = html.length; 
        const extraSec = Math.floor(charsApprox / 35); // ~35 caractères par seconde ≈ lisible
        const duration = Math.max(baseDuration, 35 + extraSec);
        
        getContainers().forEach(c => {
          c.style.animationDuration = `${duration}s`;
        });
      }

    } catch (err) {
      console.error("Erreur chargement dédicaces :", err);
      getContainers().forEach(c => {
        c.innerHTML = '<span class="opacity-70">Dédicaces indisponibles pour le moment…</span>';
      });
    }
  }

  // Lancement immédiat + refresh toutes les 45–60s
  loadDedications();
  setInterval(loadDedications, 45000); // 45 secondes – bon compromis fraîcheur / charge serveur

})();

document.addEventListener("astro:after-swap", () => {
  loadDedications();
});
