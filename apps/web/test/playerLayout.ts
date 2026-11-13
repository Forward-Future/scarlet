import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect } from "vitest";
import baseCss from "../src/index.css?inline";
import workspaceCss from "../src/workspace.css?inline";
import simpleCss from "../src/simple.css?inline";

type PlayerExample = { aspect: number; markup: string };

/** Measure each rendered player in macOS WebKit. Happy DOM cannot resolve CSS grid, aspect ratios or container units. */
export function checkPlayerLayout(examples: PlayerExample[]) {
  const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <style>${baseCss}\n${workspaceCss}\n${simpleCss}</style>
    <div class="workspace-stage simple-stage"></div>
    ${examples.map(({ aspect, markup }) => `<template data-aspect="${aspect}">${markup}</template>`).join("")}`;
  const measure = `(() => {
    const stage = document.querySelector(".workspace-stage");
    const layouts = [];
    for (const example of document.querySelectorAll("template")) {
      stage.replaceChildren(example.content.cloneNode(true));
      for (const [width, height, wide] of [[800, 780, false], [1050, 480, true]]) {
        stage.style.width = width + "px";
        stage.style.height = height + "px";
        const monitorElement = stage.querySelector(".watch-monitor");
        const rect = selector => stage.querySelector(selector).getBoundingClientRect();
        const viewport = rect(".watch-viewport"), monitor = rect(".watch-monitor"), picture = rect(".video-frame");
        const insetX = picture.left - monitor.left, insetY = picture.top - monitor.top;
        // Hit the letterbox or pillarbox midway between the picture and the edge of the monitor.
        const x = insetX > insetY ? monitor.left + insetX / 2 : monitor.left + monitor.width / 2;
        const y = insetX > insetY ? monitor.top + monitor.height / 2 : monitor.top + insetY / 2;
        layouts.push({ aspect: Number(example.dataset.aspect), width, height, wide,
          viewport: viewport.toJSON(), monitor: monitor.toJSON(), picture: picture.toJSON(),
          surface: rect(".video-surface").toJSON(),
          background: getComputedStyle(monitorElement).backgroundColor, timelineTop: rect(".cut-transport").top,
          playback: rect(".monitor-playback").toJSON(), controls: rect(".monitor-controls").toJSON(),
          surroundTargetsVideo: !!document.elementFromPoint(x, y)?.closest(".video-surface") });
      }
    }
    return layouts;
  })()`;
  const output = execFileSync("xcrun", ["swift", join(import.meta.dirname, "measureLayout.swift")], {
    input: JSON.stringify({ html, measure }), encoding: "utf8", timeout: 90_000,
  });
  const layouts: { aspect: number; width: number; height: number; wide: boolean; viewport: DOMRect; monitor: DOMRect;
    picture: DOMRect; surface: DOMRect; background: string; timelineTop: number; playback: DOMRect; controls: DOMRect; surroundTargetsVideo: boolean }[] = JSON.parse(output);
  expect(layouts).toHaveLength(examples.length * 2);
  for (const layout of layouts) {
    const { aspect, width, height, viewport, monitor, picture, surface } = layout;
    const context = `aspect ${aspect} in a ${width}×${height} stage`;
    // Layout rounds fractional CSS pixels. The picture fits inside the monitor border.
    const near = (actual: number, expected: number, dimension: string) =>
      expect(Math.abs(actual - expected), `${context}: ${dimension} (${actual}, expected ${expected})`).toBeLessThanOrEqual(2);
    expect(viewport.height, context).toBeGreaterThan(0);
    expect(viewport.width / viewport.height > 16 / 9, context).toBe(layout.wide);
    const pictureWidth = Math.min(surface.width, surface.height * aspect);
    near(picture.width, pictureWidth, "picture width");
    near(picture.height, pictureWidth / aspect, "picture height");
    near(picture.x + picture.width / 2, viewport.x + viewport.width / 2, "picture center x");
    near(picture.y + picture.height / 2, viewport.y + viewport.height / 2, "picture center y");
    if (aspect > 1) {
      near(monitor.width, viewport.width, "landscape monitor width");
      near(monitor.height, viewport.height, "landscape monitor height");
      near(layout.timelineTop - monitor.bottom, 8, "gutter above timeline");
      const [red, green, blue, opacity = 1] = layout.background.match(/[\d.]+/g)!.map(Number);
      expect(Math.max(red!, green!, blue!), `${context}: dark monitor backing`).toBeLessThan(40);
      expect(opacity, `${context}: visible monitor backing`).toBeGreaterThanOrEqual(0.4);
      expect(layout.surroundTargetsVideo, `${context}: surround targets playback`).toBe(true);
      if (!layout.wide) {
        expect(layout.playback.top, context).toBeGreaterThan(picture.bottom);
        expect(layout.controls.top, context).toBeGreaterThan(picture.bottom);
        expect(layout.controls.bottom, context).toBeLessThanOrEqual(monitor.bottom);
      }
    } else {
      const fittedWidth = Math.min(viewport.width, viewport.height * aspect);
      near(monitor.width, fittedWidth, "monitor width");
      near(monitor.height, fittedWidth / aspect, "monitor height");
    }
  }
}
