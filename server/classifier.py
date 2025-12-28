import torch
import torch.nn as nn
from transformers import AutoTokenizer, AutoConfig, AutoModel, PreTrainedModel

from torch.export import export
from torch.export.dynamic_shapes import Dim

# We should improve it later to make optimal CPU / GPU inference
class DesklibAIDetectionModel(PreTrainedModel):
    config_class = AutoConfig

    def __init__(self, config):
        super().__init__(config)
        # Initialize the base transformer model.
        self.model = AutoModel.from_config(config)
        # Define a classifier head.
        self.classifier = nn.Linear(config.hidden_size, 1)
        # Initialize weights (handled by PreTrainedModel)
        self.init_weights()

    def forward(self, input_ids, attention_mask=None, labels=None):
        # Forward pass through the transformer
        outputs = self.model(input_ids, attention_mask=attention_mask)
        last_hidden_state = outputs[0]
        # Mean pooling
        input_mask_expanded = attention_mask.unsqueeze(-1).expand(last_hidden_state.size()).float()
        sum_embeddings = torch.sum(last_hidden_state * input_mask_expanded, dim=1)
        sum_mask = torch.clamp(input_mask_expanded.sum(dim=1), min=1e-9)
        pooled_output = sum_embeddings / sum_mask

        # Classifier
        logits = self.classifier(pooled_output)
        loss = None
        if labels is not None:
            loss_fct = nn.BCEWithLogitsLoss()
            loss = loss_fct(logits.view(-1), labels.float())

        output = {"logits": logits}
        if loss is not None:
            output["loss"] = loss
        return output

def predict_batch_texts(text, model, tokenizer, device, max_len=768, threshold=0.5, exported = False):
    if isinstance(text, str):
        text = [text]
    encoded = tokenizer(
        text,
        padding='max_length',
        truncation=True,
        max_length=max_len,
        return_tensors='pt'
    )
    input_ids = encoded['input_ids'].to(device)
    attention_mask = encoded['attention_mask'].to(device)
    with torch.inference_mode():
        if exported:
            outputs = model.module()(input_ids, attention_mask)
        else:
            outputs = model(input_ids=input_ids, attention_mask=attention_mask)
        logits = outputs["logits"]
        probability = torch.sigmoid(logits)
    #if probability.shape[0]>1:
    #    probability = probability.squeeze()
    reward = probability.view(-1,)
    return torch.round(reward*100,decimals=1)

def export_model(model, tokenizer, sampled_input: str):
    args = tokenizer(
        [sampled_input],
        padding='max_length',
        truncation=True,
        max_length=768,
        return_tensors='pt'
    )
    dynamic_shapes = {
        "input_ids": (Dim.AUTO,Dim.AUTO),
        "attention_mask": (Dim.AUTO,Dim.AUTO),
    }
    d = dict(args)
    iids = d['input_ids']
    am = d['attention_mask']
    exported_program = export(model, (iids, am), dynamic_shapes=dynamic_shapes)
    return exported_program