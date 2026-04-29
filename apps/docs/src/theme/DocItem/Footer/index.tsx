import React from "react";
import OriginalFooter from "@theme-original/DocItem/Footer";
import type OriginalFooterType from "@theme/DocItem/Footer";
import type { WrapperProps } from "@docusaurus/types";
import HelpfulFeedback from "../../../components/HelpfulFeedback";

type Props = WrapperProps<typeof OriginalFooterType>;

export default function DocItemFooterWrapper(props: Props): JSX.Element {
  return (
    <>
      <HelpfulFeedback />
      <OriginalFooter {...props} />
    </>
  );
}
