/*
 * Flagship — scroll-reveal + magnetic-hover runtime. Vanilla, tiny.
 *
 * Mark anything you want to fade up on scroll with class="reveal". Group
 * siblings under data-reveal-stagger to cascade them in. Anchors with
 * data-magnetic gently pull toward the cursor.
 *
 * Honors prefers-reduced-motion by short-circuiting both effects.
 */

(function () {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    document.documentElement.classList.add("motion-reduced");
    document.querySelectorAll(".reveal").forEach((el) => el.classList.add("is-in"));
    return;
  }

  // 1) Index any staggered groups so each child knows its position.
  document.querySelectorAll("[data-reveal-stagger]").forEach((group) => {
    const items = group.querySelectorAll(".reveal");
    items.forEach((el, i) => {
      if (!el.style.getPropertyValue("--reveal-delay")) {
        el.style.setProperty("--reveal-delay", String(i));
      }
    });
  });

  // 2) IntersectionObserver — fires once per element, then unobserves.
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-in");
          io.unobserve(entry.target);
        }
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

  // 3) Magnetic hover — declarative. Only activates on pointers that
  //    can hover (skips coarse touch screens).
  if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    document.querySelectorAll("[data-magnetic]").forEach((el) => {
      const strength = parseFloat(el.dataset.magnetic) || 12;
      let raf = 0;
      el.style.transition = "transform 300ms cubic-bezier(0.16, 1, 0.3, 1)";
      el.addEventListener("pointermove", (e) => {
        const rect = el.getBoundingClientRect();
        const x = e.clientX - rect.left - rect.width / 2;
        const y = e.clientY - rect.top - rect.height / 2;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          el.style.transform =
            `translate3d(${(x / rect.width) * strength}px, ${(y / rect.height) * strength}px, 0)`;
        });
      });
      el.addEventListener("pointerleave", () => {
        cancelAnimationFrame(raf);
        el.style.transform = "translate3d(0,0,0)";
      });
    });
  }

  // 4) Parallax — anything tagged data-parallax shifts vertically with scroll.
  if (window.matchMedia("(min-width: 720px)").matches) {
    const parallaxers = document.querySelectorAll("[data-parallax]");
    if (parallaxers.length) {
      let ticking = false;
      const update = () => {
        const vh = window.innerHeight;
        parallaxers.forEach((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.bottom < -200 || rect.top > vh + 200) return;
          const speed = parseFloat(el.dataset.parallax) || 0.08;
          const offset = (rect.top - vh / 2) * speed * -1;
          el.style.transform = `translate3d(0, ${offset.toFixed(1)}px, 0)`;
        });
        ticking = false;
      };
      window.addEventListener(
        "scroll",
        () => {
          if (!ticking) {
            ticking = true;
            requestAnimationFrame(update);
          }
        },
        { passive: true },
      );
      update();
    }
  }

  // 5) Smooth scroll for in-page anchors that lack the default behavior.
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener("click", (e) => {
      const id = a.getAttribute("href").slice(1);
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    });
  });
})();
