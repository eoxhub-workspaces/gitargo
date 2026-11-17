// Override the Error overlay manually
if (process.env.NODE_ENV === "development") {
  window.addEventListener("error", (e) => {
    if (
      e.message &&
      (e.message.includes("resetSchema") ||
        e.message.includes("Missing requestHandler or method:"))
    ) {
      e.stopImmediatePropagation();
    }
  });

  window.addEventListener("unhandledrejection", (e) => {
    if (
      e.reason &&
      e.reason.message &&
      (e.reason.message.includes("resetSchema") ||
        e.reason.message.includes("Missing requestHandler or method:"))
    ) {
      e.stopImmediatePropagation();
      e.preventDefault();

      // Attempt to hide the webpack overlay if it manages to render
      setTimeout(() => {
        const overlay = document.getElementById(
          "webpack-dev-server-client-overlay-div"
        );
        if (overlay) {
          overlay.style.display = "none";
        }
      }, 10);
    }
  });
}
