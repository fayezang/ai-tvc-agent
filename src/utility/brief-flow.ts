import type { ProjectSummary } from "../shared/contracts.js";

export interface BriefRestatement {
  productAndSellingPoint: string;
  creativeIdea: string;
  visualStyle: string;
}

export const buildInitialBrief = (project: ProjectSummary, sourceMarkdown: string): string => {
  const source = sourceMarkdown || "用户暂未填写文字描述，可在此处补充。";
  return `# 首页 Brief 输入

${source}

## 项目设置

- 画幅：${project.aspectRatio ?? "16:9"}
- 时长：${project.adDuration} 秒

> 文本 AI 将根据以上输入生成“我理解的 Brief”。
`;
};

export const buildBriefRestatementMarkdown = (
  project: ProjectSummary,
  restatement: BriefRestatement
): string => {
  const fallback = "首页输入中未明确，请补充或直接编辑。";
  return `# 我理解的 Brief

## 产品 + 核心卖点

${restatement.productAndSellingPoint.trim() || fallback}

## 创意点

${restatement.creativeIdea.trim() || fallback}

## 画面风格

${restatement.visualStyle.trim() || fallback}

## 画幅

${project.aspectRatio ?? "16:9"}

## 时长

${project.adDuration} 秒
`;
};
