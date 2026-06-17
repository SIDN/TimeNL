(function () {

  // btn-nav: navigate on click (replaces <form> submit)
  document.querySelectorAll('.btn-nav[data-href]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      window.location.href = btn.dataset.href;
    });
  });

  // Accordion: one panel open per group
  document.querySelectorAll('.btn-accordion').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var panelId = btn.dataset.panel;
      var groupId = btn.dataset.group;
      var panel   = document.getElementById(panelId);
      var isOpen  = btn.classList.contains('active');

      // Close all in the same group
      document.querySelectorAll('.btn-accordion[data-group="' + groupId + '"]').forEach(function (b) {
        b.classList.remove('active');
        var p = document.getElementById(b.dataset.panel);
        if (p) p.classList.remove('open');
      });

      // Toggle the clicked one open (unless it was already open)
      if (!isOpen && panel) {
        btn.classList.add('active');
        panel.classList.add('open');
      }
    });
  });
  
})();
