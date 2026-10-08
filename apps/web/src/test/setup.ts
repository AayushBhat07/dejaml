// jsdom has no canvas; the campus scene skips drawing when getContext returns null.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
