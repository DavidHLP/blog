import mermaid from 'mermaid';

// 存储原始 Mermaid 代码
const mermaidCodeMap = new Map<Element, string>();
let renderCount = 0;

/**
 * 初始化 Mermaid 并根据主题自动渲染图表
 */
export function initMermaid() {
	// 获取当前主题
	const getCurrentTheme = (): 'dark' | 'light' => {
		const theme = document.documentElement.dataset.theme;
		if (theme === 'dark' || theme === 'light') {
			return theme;
		}
		// 如果没有设置主题,使用系统偏好
		return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	};

	// 根据主题初始化 Mermaid
	const initMermaidWithTheme = (theme: 'dark' | 'light') => {
		mermaid.initialize({
			startOnLoad: false,
			theme: theme === 'dark' ? 'dark' : 'default',
			themeVariables: {
				fontFamily: 'var(--serif)',
			},
			securityLevel: 'loose',
		});
	};

	// 渲染所有 Mermaid 图表
	const renderMermaidDiagrams = async () => {
		const theme = getCurrentTheme();
		initMermaidWithTheme(theme);

		// 查找所有 mermaid 代码块
		const codeBlocks = document.querySelectorAll('pre code.language-mermaid');

		let index = 0;
		for (const codeBlock of codeBlocks) {
			const pre = codeBlock.parentElement;
			if (!pre) continue;

			// 获取 mermaid 代码
			const code = codeBlock.textContent || '';

			// 创建一个容器用于渲染
			const container = document.createElement('div');
			container.className = 'mermaid';
			container.setAttribute('data-mermaid-index', String(index));

			// 保存原始代码
			mermaidCodeMap.set(container, code);

			// 使用 mermaid.render 渲染
			try {
				const id = `mermaid-${renderCount}-${index}`;
				const { svg } = await mermaid.render(id, code);
				container.innerHTML = svg;
			} catch (error) {
				console.error('Mermaid rendering error:', error);
				container.innerHTML = `<pre>Mermaid Error: ${error}</pre>`;
			}

			// 替换原来的 pre 元素
			pre.replaceWith(container);
			index++;
		}

		renderCount++;
	};

	// 监听主题切换
	const observeThemeChange = () => {
		const observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				if (
					mutation.type === 'attributes' &&
					mutation.attributeName === 'data-theme'
				) {
					// 主题改变时重新渲染
					reRenderMermaidDiagrams();
					break;
				}
			}
		});

		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme'],
		});
	};

	// 重新渲染所有图表
	const reRenderMermaidDiagrams = async () => {
		const theme = getCurrentTheme();
		initMermaidWithTheme(theme);

		// 查找所有已渲染的 mermaid 图表
		const diagrams = document.querySelectorAll('.mermaid');

		if (diagrams.length === 0) return;

		// 为每个图表重新渲染
		let index = 0;
		for (const diagram of diagrams) {
			// 获取原始代码
			const code = mermaidCodeMap.get(diagram);
			if (!code) continue;

			try {
				const id = `mermaid-${renderCount}-${index}`;
				const { svg } = await mermaid.render(id, code);
				diagram.innerHTML = svg;
			} catch (error) {
				console.error('Mermaid re-rendering error:', error);
				diagram.innerHTML = `<pre>Mermaid Error: ${error}</pre>`;
			}

			index++;
		}

		renderCount++;
	};

	// 初始化
	renderMermaidDiagrams();
	observeThemeChange();
}
