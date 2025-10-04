// Elements
const provinceSelect = document.getElementById("province");
const searchInput = document.getElementById("search");
const tbody = document.getElementById("tbody");
const totalCountEl = document.getElementById("totalCount");
const displayCountEl = document.getElementById("displayCount");
const progressContainer = document.getElementById("progressContainer");
const progressBar = document.getElementById("progressBar");
const loadingStats = document.getElementById("loadingStats");
const loadingText = document.getElementById("loadingText");
const tableContainer = document.querySelector(".table-container");

// State
let allHospitals = [];
let filteredHospitals = [];
let currentController = null;
let currentProvinceId = null;

// URL State Management
const updateURL = (provinceId, searchQuery) => {
  const url = new URL(window.location);
  if (provinceId) {
    url.searchParams.set('province', provinceId);
  } else {
    url.searchParams.delete('province');
  }
  if (searchQuery) {
    url.searchParams.set('search', searchQuery);
  } else {
    url.searchParams.delete('search');
  }
  window.history.replaceState({}, '', url);
};

const getURLParams = () => {
  const params = new URLSearchParams(window.location.search);
  return {
    province: params.get('province'),
    search: params.get('search')
  };
};

// Caches
const pageCache = new Map(); // key: `${provinceId}-${page}` => raw HTML
const provinceHospitalsCache = new Map(); // key: provinceId => hospitals[]

// Utils
const debounce = (fn, delay = 250) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
};

const showLoading = () => {
  // Show loading UI
  progressContainer.style.display = 'block';
  progressBar.className = 'progress-bar indeterminate';
  loadingStats.style.display = 'flex';
  loadingText.textContent = 'Đang tải dữ liệu...';
  tableContainer.classList.add('loading-state');
  
  // Show skeleton rows
  const skeletonRows = Array.from({ length: 5 }, (_, i) => `
    <tr>
      <td><div class="skeleton skeleton-text short"></div></td>
      <td><div class="skeleton skeleton-text medium"></div></td>
      <td><div class="skeleton skeleton-text long"></div></td>
      <td><div class="skeleton skeleton-text short"></div></td>
      <td><div class="skeleton skeleton-text medium"></div></td>
      <td><div class="skeleton skeleton-text short"></div></td>
    </tr>
  `).join('');
  
  tbody.innerHTML = skeletonRows;
};

const hideLoading = () => {
  progressContainer.style.display = 'none';
  loadingStats.style.display = 'none';
  tableContainer.classList.remove('loading-state');
};

const updateProgress = (current, total) => {
  if (total > 0) {
    progressBar.className = 'progress-bar';
    progressBar.style.width = `${(current / total) * 100}%`;
    loadingText.textContent = `Đã tải ${current}/${total} bệnh viện...`;
  }
};

const showError = (message) => {
  hideLoading();
  tbody.innerHTML = `
    <tr>
      <td colspan="6" class="error">
        ❌ ${message}
      </td>
    </tr>
  `;
};

const showEmpty = () => {
  hideLoading();
  tbody.innerHTML = `
    <tr>
      <td colspan="6" class="empty">
        📭 Không tìm thấy bệnh viện nào
      </td>
    </tr>
  `;
};

const updateStats = () => {
  totalCountEl.textContent = allHospitals.length;
  displayCountEl.textContent = filteredHospitals.length;
};

const renderTable = (data) => {
  filteredHospitals = data;
  updateStats();
  hideLoading();

  if (data.length === 0) {
    showEmpty();
    return;
  }

  // Using innerHTML is faster here than row-by-row DOM ops
  tbody.innerHTML = data
    .map(
      (h) => `
    <tr class="fade-in">
      <td class="stt">${h.stt}</td>
      <td>${h.date}</td>
      <td class="logo">
        ${h.logo ? `<img src="${h.logo}" alt="Logo" onerror="this.style.display='none'" />` : "—"}
      </td>
      <td class="name">${h.name}</td>
      <td class="website">
        ${h.website ? `<a href="${h.website}" target="_blank" rel="noopener">🔗 Truy cập</a>` : "—"}
      </td>
      <td>
        ${h.decision ? `<a href="${h.decision}" target="_blank" rel="noopener" class="btn-link">📄 Xem QĐ</a>` : "—"}
      </td>
    </tr>`
    )
    .join("");
};

const parseHospitalsFromHTML = (html) => {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rows = doc.querySelectorAll("div.table-benhvien table tbody tr");

  return Array.from(rows)
    .map((tr) => {
      const sttEl = tr.querySelector("td.text-center");
      const dateEl = tr.querySelector("td span.date");
      const logoEl = tr.querySelector("td img");
      const nameEl = tr.querySelector("td h3.name");
      const websiteEl = tr.querySelector("td a.website");
      const decisionEl = tr.querySelector("td a.product-datasets__label");

      return {
        stt: sttEl?.textContent.trim() || "",
        date: dateEl?.textContent.trim() || "",
        logo: logoEl?.getAttribute("src") || "",
        name: nameEl?.textContent.trim() || "",
        website: websiteEl?.getAttribute("href") || "",
        decision: decisionEl?.getAttribute("href") || "",
      };
    })
    .filter((h) => h.name);
};

const fetchPageData = async (provinceId, page, signal) => {
  const cacheKey = `${provinceId}-${page}`;
  if (pageCache.has(cacheKey)) return pageCache.get(cacheKey);

  const url = `https://api.allorigins.win/raw?url=${encodeURIComponent(
    `https://benhandientu.moh.gov.vn/?page=${page}&province_id=${provinceId}`
  )}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error("Không thể tải dữ liệu");
  const text = await res.text();
  pageCache.set(cacheKey, text);
  return text;
};

// Concurrency-limited page fetching
const fetchRemainingPages = async (provinceId, startPage, controller, opts = {}) => {
  const { concurrency = 3, onProgress } = opts;
  let nextPage = startPage;
  let stop = false;
  const results = [];
  const emptyPageCount = { count: 0 };

  const workers = Array.from({ length: concurrency }, async () => {
    while (!stop && !controller.signal.aborted) {
      const myPage = nextPage++;
      try {
        const pageHTML = await fetchPageData(provinceId, myPage, controller.signal);
        const pageHospitals = parseHospitalsFromHTML(pageHTML);
        if (pageHospitals.length === 0) {
          emptyPageCount.count++;
          // Stop only if we've seen 2+ consecutive empty pages
          if (emptyPageCount.count >= 2) {
            stop = true;
          }
          break;
        } else {
          emptyPageCount.count = 0; // Reset counter on successful page
          results.push(...pageHospitals);
          if (typeof onProgress === "function") onProgress(results);
        }
      } catch (e) {
        if (e.name === 'AbortError') break;
        // Network error: try next page after short delay
        await new Promise(resolve => setTimeout(resolve, 100));
        break;
      }
    }
  });

  await Promise.all(workers);
  return results;
};

const applySearchFilter = () => {
  const keyword = searchInput.value.toLowerCase().trim();
  const filtered = keyword
    ? allHospitals.filter((h) => h.name.toLowerCase().includes(keyword))
    : allHospitals;
  renderTable(filtered);
};

const fetchData = async (provinceId) => {
  // Abort previous
  if (currentController) currentController.abort();
  currentController = new AbortController();
  currentProvinceId = provinceId;

  // If cached aggregated hospitals exist, use them immediately
  if (provinceHospitalsCache.has(provinceId)) {
    allHospitals = provinceHospitalsCache.get(provinceId);
    applySearchFilter();
    // Still refresh in background to keep cache warm
  } else {
    showLoading();
    allHospitals = [];
    filteredHospitals = [];
    updateStats();
  }

  try {
    // First page
    const firstPageHTML = await fetchPageData(provinceId, 1, currentController.signal);
    const firstHospitals = parseHospitalsFromHTML(firstPageHTML);
    if (firstHospitals.length === 0) {
      allHospitals = [];
      renderTable(allHospitals);
      return;
    }

    allHospitals = [...firstHospitals];
    // Render early only if no search keyword to reduce DOM churn
    if (!searchInput.value.trim()) renderTable(allHospitals);

    // Remaining pages with limited concurrency and progress tracking
    const startTime = performance.now();
    let totalEstimate = firstHospitals.length * 10; // Rough estimate
    const moreHospitals = await fetchRemainingPages(
      provinceId,
      2,
      currentController,
      {
        concurrency: 3,
        onProgress: debounce((currentResults) => {
          const totalLoaded = firstHospitals.length + currentResults.length;
          updateProgress(totalLoaded, Math.max(totalEstimate, totalLoaded + 50));
          // During background load, re-render occasionally if no active search
          if (!searchInput.value.trim()) {
            const tempAllHospitals = [...firstHospitals, ...currentResults];
            renderTable(tempAllHospitals);
          }
        }, 300),
      }
    );

    // If aborted, don't continue
    if (currentController.signal.aborted) return;

    // Merge all results correctly (firstHospitals + moreHospitals)
    allHospitals = [...firstHospitals, ...moreHospitals];
    provinceHospitalsCache.set(provinceId, allHospitals);
    applySearchFilter();

    const duration = Math.round(performance.now() - startTime);
    // Optionally log for debugging: console.log(`Loaded in ${duration}ms`);
  } catch (error) {
    if (currentController.signal.aborted) return; // ignore aborts
    console.error(error);
    showError("Lỗi khi tải dữ liệu. Vui lòng thử lại sau.");
  }
};

// Events
provinceSelect.addEventListener("change", () => {
  const id = provinceSelect.value;
  searchInput.value = "";
  updateURL(id, "");
  if (id) {
    fetchData(id);
  } else {
    allHospitals = [];
    filteredHospitals = [];
    updateStats();
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="empty">
          👆 Vui lòng chọn tỉnh/thành phố để xem danh sách bệnh viện
        </td>
      </tr>
    `;
  }
});

searchInput.addEventListener(
  "input",
  debounce(() => {
    const searchQuery = searchInput.value.trim();
    updateURL(provinceSelect.value, searchQuery);
    applySearchFilter();
  }, 200)
);

// Initialize from URL params
const initializeFromURL = () => {
  const { province, search } = getURLParams();
  if (province) {
    provinceSelect.value = province;
    if (search) {
      searchInput.value = search;
    }
    fetchData(province);
  } else {
    updateStats();
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="empty">
          👆 Vui lòng chọn tỉnh/thành phố để xem danh sách bệnh viện
        </td>
      </tr>
    `;
  }
};

// Handle browser back/forward
window.addEventListener('popstate', initializeFromURL);

// Initialize
initializeFromURL();